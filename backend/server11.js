const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Файл для хранения статистики
const statsFilePath = path.join(__dirname, 'stats.json');

// Хранилище активных сессий (в памяти)
const activeSessions = new Map();

// ============================================
// УТИЛИТЫ ДЛЯ РАБОТЫ СО СТАТИСТИКОЙ
// ============================================

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

const saveStats = (stats) => {
    try {
        console.log('💾 Saving stats to:', statsFilePath);
        fs.writeFileSync(statsFilePath, JSON.stringify(stats, null, 2));
        console.log('✅ Stats saved successfully');
        
        if (fs.existsSync(statsFilePath)) {
            const fileSize = fs.statSync(statsFilePath).size;
            console.log(`✅ File exists, size: ${fileSize} bytes`);
        }
    } catch (err) {
        console.error('❌ Error saving stats:', err);
        console.error('❌ Path:', statsFilePath);
    }
};

const getClientIP = (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           'unknown';
};

const createSessionId = (ip) => {
    return `${ip}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

const getDateKey = (date = new Date()) => {
    return date.toISOString().split('T')[0];
};

function getEnginePath() {
    if (process.platform === 'win32') {
        return path.join(__dirname, 'engines', 'fairy-stockfish-largeboard_x86-64.exe');
    } else {
        return path.join(__dirname, 'engines', 'fairy-stockfish-largeboard_x86-64');
    }
}

// Middleware
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Дополнительно: убедимся что CORS правильный для cookies
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,Cookie');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ============================================
// MIDDLEWARE ДЛЯ ОТСЛЕЖИВАНИЯ ЗАПРОСОВ
// ============================================

app.use((req, res, next) => {
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const now = new Date();
    const method = req.method;
    const url = req.originalUrl || req.url;
    
    // ИСПОЛЬЗУЕМ IP КАК КЛЮЧ СЕССИИ (проще и надёжнее cookies!)
    const sessionKey = `${ip}_${userAgent}`;
    let session = activeSessions.get(sessionKey);
    
    if (!session) {
        // Создаём новую сессию для этого IP + UserAgent
        const sessionId = createSessionId(ip);
        session = {
            id: sessionId,
            ip,
            userAgent,
            startTime: now.toISOString(),
            lastActivity: now.toISOString(),
            requests: [],
            requestCount: 0
        };
        activeSessions.set(sessionKey, session);
        console.log(`🔵 New session: ${sessionId} from ${ip}`);
    } else {
        console.log(`♻️ Existing session: ${session.id} from ${ip}`);
    }
    
    // Обновляем активность
    session.lastActivity = now.toISOString();
    session.requestCount++;
    
    // Добавляем информацию о запросе (с FEN для /get-best-move)
    const requestInfo = { method, url, timestamp: now.toISOString() };
    
    // Если это запрос к движку - добавляем FEN позицию
    if (url.includes('/get-best-move') && req.body && req.body.fen) {
        requestInfo.fen = req.body.fen;
    }
    
    session.requests.push(requestInfo);
    
    console.log(`📊 ${method} ${url} | Session: ${session.id} | Requests: ${session.requestCount}`);
   
    next();
});

// ============================================
// СОХРАНЕНИЕ СТАТИСТИКИ
// ============================================

const flushStats = () => {
    try {
        console.log('🔄 Flushing stats...');
        const stats = readStats();
        const now = new Date();
        const dateKey = getDateKey(now);
        
        console.log(`📅 Date key: ${dateKey}`);
        console.log(`📊 Active sessions: ${activeSessions.size}`);
        
        // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: проверяем stats.daily ПЕРЕД использованием
        if (!stats.daily) {
            console.log('⚠️ stats.daily was undefined, creating empty object');
            stats.daily = {};
        }
        
        if (!stats.daily[dateKey]) {
            stats.daily[dateKey] = {
                date: dateKey,
                totalRequests: 0,
                uniqueIPs: new Set(),
                sessions: []
            };
        }
        
        const dailyStats = stats.daily[dateKey];
        
        // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: uniqueIPs ВСЕГДА массив после чтения из JSON
        if (!dailyStats.uniqueIPs) {
            console.log('⚠️ uniqueIPs was null/undefined, creating new Set');
            dailyStats.uniqueIPs = new Set();
        } else if (Array.isArray(dailyStats.uniqueIPs)) {
            console.log(`⚠️ uniqueIPs was Array (length: ${dailyStats.uniqueIPs.length}), converting to Set`);
            dailyStats.uniqueIPs = new Set(dailyStats.uniqueIPs);
        } else if (!(dailyStats.uniqueIPs instanceof Set)) {
            console.log(`⚠️ uniqueIPs was ${typeof dailyStats.uniqueIPs}, creating new Set`);
            dailyStats.uniqueIPs = new Set();
        }
        
        console.log(`📊 Processing ${activeSessions.size} active sessions...`);
        
        // ИСПРАВЛЕНО: итерируем по activeSessions правильно
        // sessionKey - это ключ Map (ip_userAgent), session - значение
        activeSessions.forEach((session, sessionKey) => {
            dailyStats.uniqueIPs.add(session.ip);
            
            // Ищем существующую сессию по session.id
            const existingSession = dailyStats.sessions.find(s => s.id === session.id);
            
            if (!existingSession) {
                dailyStats.sessions.push({
                    id: session.id,
                    ip: session.ip,
                    startTime: session.startTime,
                    endTime: session.lastActivity,
                    requestCount: session.requestCount,
                    requests: session.requests.slice()
                });
                console.log(`📝 Added new session to daily stats: ${session.id}`);
            } else {
                existingSession.endTime = session.lastActivity;
                existingSession.requestCount = session.requestCount;
                existingSession.requests = session.requests.slice();
                console.log(`📝 Updated existing session: ${session.id}`);
            }

        });
        
        dailyStats.totalRequests = dailyStats.sessions.reduce((sum, s) => sum + s.requestCount, 0);
        dailyStats.uniqueIPs = Array.from(dailyStats.uniqueIPs);
        
        saveStats(stats);
        console.log(`💾 Stats flushed: ${activeSessions.size} active sessions, ${dailyStats.sessions.length} in daily`);
    } catch (err) {
        console.error('❌ Error flushing stats:', err);
        console.error('❌ Stack:', err.stack);
    }
};

// Сохраняем статистику каждые 30 секунд (для тестирования)
setInterval(flushStats, 30 * 1000);

// Первое сохранение через 5 секунд после запуска
setTimeout(flushStats, 5000);

const cleanupSessions = () => {
    const now = new Date();
    const timeout = 30 * 60 * 1000;
    
    activeSessions.forEach((session, sessionKey) => {
        const lastActivity = new Date(session.lastActivity);
        if (now - lastActivity > timeout) {
            console.log(`🔴 Closing session: ${session.id}`);
            activeSessions.delete(sessionKey);
        }
    });
};

setInterval(cleanupSessions, 10 * 60 * 1000);

// ============================================
// API СТАТИСТИКИ
// ============================================

app.get('/api/stats/:date', (req, res) => {
    try {
        const stats = readStats();
        
        if (!stats || !stats.daily) {
            return res.status(404).json({ 
                success: false, 
                message: 'No statistics data available yet' 
            });
        }
        
        if (stats.daily[req.params.date]) {
            res.json({ success: true, date: req.params.date, data: stats.daily[req.params.date] });
        } else {
            res.status(404).json({ success: false, message: 'No data for this date' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/stats/detailed/:date', (req, res) => {
    try {
        const stats = readStats();
        const dateKey = req.params.date;
        
        if (!stats || !stats.daily) {
            return res.status(404).json({ 
                success: false, 
                message: 'No statistics data available yet' 
            });
        }
        
        if (!stats.daily[dateKey]) {
            return res.status(404).json({ 
                success: false, 
                message: `No data for date ${dateKey}` 
            });
        }
        
        const dayStats = stats.daily[dateKey];
        
        const detailedSessions = dayStats.sessions.map(session => ({
            id: session.id,
            ip: session.ip,
            startTime: session.startTime,
            lastActivity: session.endTime,
            requestCount: session.requestCount,
            urls: session.requests.map(r => r.url),
            requests: session.requests
        }));

        
        res.json({
            success: true,
            date: dateKey,
            summary: {
                totalSessions: dayStats.sessions.length,
                totalRequests: dayStats.totalRequests,
                uniqueIPs: dayStats.uniqueIPs.length
            },
            sessions: detailedSessions
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/stats/summary', (req, res) => {
    try {
        flushStats(); // Принудительно сохраняем перед отправкой
        
        const stats = readStats();
        
        if (!stats || !stats.daily) {
            return res.json({
                success: true,
                totalDays: 0,
                days: [],
                message: 'No statistics collected yet'
            });
        }
        
        const summary = Object.keys(stats.daily).map(date => {
            const day = stats.daily[date];
            return {
                date,
                totalSessions: day.sessions.length,
                totalRequests: day.totalRequests,
                uniqueIPs: day.uniqueIPs.length
            };
        }).sort((a, b) => b.date.localeCompare(a.date));
        
        res.json({
            success: true,
            totalDays: summary.length,
            days: summary
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        flushStats(); // Принудительно сохраняем
        res.json({ success: true, data: readStats() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/sessions/active', (req, res) => {
    try {
        flushStats(); // Принудительно сохраняем
        res.json({ success: true, count: activeSessions.size, sessions: Array.from(activeSessions.values()) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// API ДЛЯ FAIRY-STOCKFISH
// ============================================

const handleBestMove = async (req, res) => {
    console.log('📩 Received FEN:', req.body.fen);
    
    const { fen, depth = 15 } = req.body;
    
    if (!fen) {
        return res.status(400).json({ error: 'FEN is required' });
    }

    try {
        const enginePath = getEnginePath();
        console.log(`🎯 Starting engine: ${enginePath}`);
        
        const engine = spawn(enginePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });

        let bestMove = null;
        let analysis = '';

        const commands = [
            'uci',
            `setoption name VariantPath value ${path.join(__dirname, 'variants', 'chessdragon.ini')}`,
            'setoption name UCI_Variant value chessdragon',
            `position fen ${fen}`,
            `go depth ${depth}`
        ];

        console.log('📝 Commands:', commands);

        for (const cmd of commands) {
            engine.stdin.write(cmd + '\n');
        }

        engine.stdout.on('data', (data) => {
            const output = data.toString();
            console.log('Engine output:', output);
            analysis += output;
            
            if (output.includes('bestmove')) {
                const match = output.match(/bestmove\s+(\S+)/);
                if (match) {
                    bestMove = match[1];
                    console.log('✅ Best move:', bestMove);
                    engine.stdin.write('quit\n');
                    
                    if (!res.headersSent) {
                        res.json({ 
                            bestMove, 
                            analysis: analysis.split('\n').filter(line => line.trim()) 
                        });
                    }
                }
            }
        });

        engine.stderr.on('data', (data) => {
            console.error('Engine stderr:', data.toString());
        });

        engine.on('close', (code) => {
            console.log(`Engine closed with code ${code}`);
            if (!bestMove && !res.headersSent) {
                res.status(500).json({ error: 'Engine closed without best move', analysis });
            }
        });

        engine.on('error', (error) => {
            console.error('❌ Engine error:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: `Engine error: ${error.message}` });
            }
        });

        setTimeout(() => {
            if (!bestMove && !res.headersSent) {
                console.log('⏱️ Engine timeout');
                engine.kill();
                res.status(500).json({ error: 'Engine timeout' });
            }
        }, 30000);

    } catch (error) {
        console.error('❌ Server error:', error);
        res.status(500).json({ error: `Server error: ${error.message}` });
    }
};

app.post('/api/get-best-move', handleBestMove);
app.post('/get-best-move', handleBestMove);

// ============================================
// СТАТИЧЕСКИЕ ФАЙЛЫ
// ============================================

app.use(express.static(path.join(__dirname, '../frontend')));

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 Statistics enabled`);
    console.log(`📁 Stats: ${statsFilePath}`);
    console.log(`📁 Absolute path: ${path.resolve(statsFilePath)}`);
    console.log(`🎯 Engine: ${getEnginePath()}`);
    console.log(`\n📊 Available stats endpoints:`);
    console.log(`   GET /api/stats/summary - Сводка по всем датам`);
    console.log(`   GET /api/stats/detailed/:date - Детальная статистика за дату`);
    console.log(`   GET /api/stats/:date - Базовая статистика за дату`);
    console.log(`   GET /api/sessions/active - Активные сессии`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    flushStats();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    flushStats();
    process.exit(0);
});
