const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Файл для хранения статистики
const statsFilePath = path.join(__dirname, 'stats.json');

// Хранилище активных сессий (в памяти)
const activeSessions = new Map();

// ============================================
// УТИЛИТЫ ДЛЯ РАБОТЫ СО СТАТИСТИКОЙ
// ============================================

// Чтение статистики из файла
const readStats = () => {
    try {
        if (fs.existsSync(statsFilePath)) {
            const data = fs.readFileSync(statsFilePath, 'utf8');
            return JSON.parse(data);
        }
        return { daily: {}, sessions: [] };
    } catch (err) {
        console.error('❌ Error reading stats:', err);
        return { daily: {}, sessions: [] };
    }
};

// Сохранение статистики в файл
const saveStats = (stats) => {
    try {
        fs.writeFileSync(statsFilePath, JSON.stringify(stats, null, 2));
        console.log('💾 Stats saved');
    } catch (err) {
        console.error('❌ Error saving stats:', err);
    }
};

// Получение IP адреса клиента
const getClientIP = (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           'unknown';
};

// Создание уникального ID сессии
const createSessionId = (ip) => {
    return `${ip}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// Получение даты в формате YYYY-MM-DD
const getDateKey = (date = new Date()) => {
    return date.toISOString().split('T')[0];
};

// Получение пути к движку в зависимости от платформы
function getEnginePath() {
    if (process.platform === 'win32') {
        return path.join(__dirname, 'engines', 'fairy-stockfish-largeboard_x86-64.exe');
    } else {
        return path.join(__dirname, 'engines', 'fairy-stockfish-largeboard_x86-64');
    }
}

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// MIDDLEWARE ДЛЯ ОТСЛЕЖИВАНИЯ ЗАПРОСОВ
// ============================================

app.use((req, res, next) => {
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const now = new Date();
    const dateKey = getDateKey(now);
    const method = req.method;
    const url = req.originalUrl || req.url;
    
    // Создаём или получаем sessionId
    let sessionId = req.headers['x-session-id'];
    
    if (!sessionId || !activeSessions.has(sessionId)) {
        // Новая сессия
        sessionId = createSessionId(ip);
        activeSessions.set(sessionId, {
            id: sessionId,
            ip,
            userAgent,
            startTime: now.toISOString(),
            lastActivity: now.toISOString(),
            requests: [],
            requestCount: 0
        });
        
        console.log(`🔵 New session: ${sessionId} from ${ip}`);
    }
    
    // Обновляем сессию
    const session = activeSessions.get(sessionId);
    session.lastActivity = now.toISOString();
    session.requestCount++;
    session.requests.push({
        method,
        url,
        timestamp: now.toISOString()
    });
    
    // Добавляем sessionId в ответ
    res.setHeader('X-Session-ID', sessionId);
    
    console.log(`📊 ${method} ${url} | Session: ${sessionId} | IP: ${ip}`);
    
    next();
});

// ============================================
// СОХРАНЕНИЕ СТАТИСТИКИ ПЕРИОДИЧЕСКИ
// ============================================

// Функция сохранения статистики
const flushStats = () => {
    try {
        const stats = readStats();
        const now = new Date();
        const dateKey = getDateKey(now);
        
        // Инициализируем дневную статистику
        if (!stats.daily[dateKey]) {
            stats.daily[dateKey] = {
                date: dateKey,
                totalRequests: 0,
                uniqueIPs: new Set(),
                sessions: []
            };
        }
        
        const dailyStats = stats.daily[dateKey];
        
        // Обрабатываем активные сессии
        activeSessions.forEach((session, sessionId) => {
            // Добавляем IP в Set уникальных IP
            dailyStats.uniqueIPs.add(session.ip);
            
            // Проверяем есть ли уже эта сессия в дневной статистике
            const existingSession = dailyStats.sessions.find(s => s.id === sessionId);
            
            if (!existingSession) {
                // Новая сессия - добавляем
                dailyStats.sessions.push({
                    id: sessionId,
                    ip: session.ip,
                    userAgent: session.userAgent,
                    startTime: session.startTime,
                    endTime: session.lastActivity,
                    requestCount: session.requestCount,
                    requests: session.requests.slice()  // Копируем массив
                });
            } else {
                // Обновляем существующую сессию
                existingSession.endTime = session.lastActivity;
                existingSession.requestCount = session.requestCount;
                existingSession.requests = session.requests.slice();
            }
        });
        
        // Пересчитываем общее количество запросов
        dailyStats.totalRequests = dailyStats.sessions.reduce((sum, s) => sum + s.requestCount, 0);
        
        // Конвертируем Set в массив для JSON
        dailyStats.uniqueIPs = Array.from(dailyStats.uniqueIPs);
        
        // Сохраняем
        saveStats(stats);
        
        console.log(`💾 Stats flushed: ${activeSessions.size} active sessions`);
    } catch (err) {
        console.error('❌ Error flushing stats:', err);
    }
};

// Сохраняем статистику каждые 5 минут
setInterval(flushStats, 5 * 60 * 1000);

// Закрытие старых сессий (неактивных более 30 минут)
const cleanupSessions = () => {
    const now = new Date();
    const timeout = 30 * 60 * 1000; // 30 минут
    
    activeSessions.forEach((session, sessionId) => {
        const lastActivity = new Date(session.lastActivity);
        if (now - lastActivity > timeout) {
            console.log(`🔴 Closing session: ${sessionId} (inactive)`);
            activeSessions.delete(sessionId);
        }
    });
};

// Очистка старых сессий каждые 10 минут
setInterval(cleanupSessions, 10 * 60 * 1000);

// ============================================
// API ДЛЯ ПОЛУЧЕНИЯ СТАТИСТИКИ
// ============================================

// Получить статистику за определённую дату
app.get('/api/stats/:date', (req, res) => {
    try {
        const dateKey = req.params.date;
        const stats = readStats();
        
        if (stats.daily[dateKey]) {
            res.json({
                success: true,
                date: dateKey,
                data: stats.daily[dateKey]
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'No data for this date'
            });
        }
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// Получить всю статистику
app.get('/api/stats', (req, res) => {
    try {
        const stats = readStats();
        res.json({
            success: true,
            data: stats
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// Получить активные сессии
app.get('/api/sessions/active', (req, res) => {
    try {
        const sessions = Array.from(activeSessions.values());
        res.json({
            success: true,
            count: sessions.length,
            sessions
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ============================================
// API ДЛЯ FAIRY-STOCKFISH
// ============================================

// Функция обработки запроса на лучший ход
const handleBestMove = (req, res) => {
    const { fen, depth } = req.body;
    
    if (!fen) {
        return res.status(400).json({ error: 'FEN is required' });
    }
    
    const effectiveDepth = depth || 10;
    const enginePath = getEnginePath();
    
    console.log(`🎯 Starting engine: ${enginePath}`);
    
    const fairyStockfish = spawn(enginePath, []);
    
    let output = '';
    let bestMove = null;
    
    fairyStockfish.stdout.on('data', (data) => {
        output += data.toString();
        const lines = output.split('\n');
        
        for (const line of lines) {
            if (line.startsWith('bestmove')) {
                const parts = line.split(' ');
                bestMove = parts[1];
            }
        }
    });
    
    fairyStockfish.on('error', (err) => {
        console.error('❌ Engine error:', err);
        res.status(500).json({ error: 'Engine failed to start: ' + err.message });
    });
    
    fairyStockfish.on('close', (code) => {
        if (bestMove) {
            console.log(`✅ Best move: ${bestMove}`);
            res.json({ bestMove });
        } else {
            console.error('❌ No best move found');
            res.status(500).json({ error: 'Failed to get best move' });
        }
    });
    
    fairyStockfish.stdin.write('uci\n');
    fairyStockfish.stdin.write('setoption name UCI_Variant value chess\n');
    fairyStockfish.stdin.write(`position fen ${fen}\n`);
    fairyStockfish.stdin.write(`go depth ${effectiveDepth}\n`);
    fairyStockfish.stdin.end();
};

// Два маршрута для обратной совместимости
app.post('/api/get-best-move', handleBestMove);
app.post('/get-best-move', handleBestMove);

// ============================================
// РАЗДАЧА СТАТИЧЕСКИХ ФАЙЛОВ (ПОСЛЕ API)
// ============================================

app.use(express.static(path.join(__dirname, '../frontend')));

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 Statistics enabled`);
    console.log(`📁 Stats file: ${statsFilePath}`);
    console.log(`🎯 Engine path: ${getEnginePath()}`);
});

// Сохранение статистики при выключении сервера
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    flushStats();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down server...');
    flushStats();
    process.exit(0);
});
