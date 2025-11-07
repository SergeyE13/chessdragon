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
        console.log('💾 Attempting to save stats to:', statsFilePath);
        fs.writeFileSync(statsFilePath, JSON.stringify(stats, null, 2));
        console.log('✅ Stats saved successfully');
        
        // Проверка что файл создан
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
app.use(cors());
app.use(express.json());

// ============================================
// MIDDLEWARE ДЛЯ ОТСЛЕЖИВАНИЯ ЗАПРОСОВ
// ============================================

app.use((req, res, next) => {
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const now = new Date();
    const method = req.method;
    const url = req.originalUrl || req.url;
    
    let sessionId = req.headers['x-session-id'];
    
    if (!sessionId || !activeSessions.has(sessionId)) {
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
    
    const session = activeSessions.get(sessionId);
    session.lastActivity = now.toISOString();
    session.requestCount++;
    session.requests.push({ method, url, timestamp: now.toISOString() });
    
    res.setHeader('X-Session-ID', sessionId);
    console.log(`📊 ${method} ${url} | Session: ${sessionId} | IP: ${ip}`);
    
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
        
        // Проверка что stats.daily существует
        if (!stats.daily) {
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
        
        // ИСПРАВЛЕНИЕ: uniqueIPs может быть массивом (из JSON), преобразуем в Set
        if (Array.isArray(dailyStats.uniqueIPs)) {
            dailyStats.uniqueIPs = new Set(dailyStats.uniqueIPs);
        } else if (!(dailyStats.uniqueIPs instanceof Set)) {
            dailyStats.uniqueIPs = new Set();
        }
        
        activeSessions.forEach((session, sessionId) => {
            dailyStats.uniqueIPs.add(session.ip);			
			
            const existingSession = dailyStats.sessions.find(s => s.id === sessionId);
            
            if (!existingSession) {
                dailyStats.sessions.push({
                    id: sessionId,
                    ip: session.ip,
                    userAgent: session.userAgent,
                    startTime: session.startTime,
                    endTime: session.lastActivity,
                    requestCount: session.requestCount,
                    requests: session.requests.slice()
                });
            } else {
                existingSession.endTime = session.lastActivity;
                existingSession.requestCount = session.requestCount;
                existingSession.requests = session.requests.slice();
            }
        });
        
        dailyStats.totalRequests = dailyStats.sessions.reduce((sum, s) => sum + s.requestCount, 0);
        dailyStats.uniqueIPs = Array.from(dailyStats.uniqueIPs);
        
        saveStats(stats);
        console.log(`💾 Stats flushed: ${activeSessions.size} active sessions`);
    } catch (err) {
        console.error('❌ Error flushing stats:', err);
    }
};

	// Сохраняем статистику каждые 30 секунд (для тестирования)
	// Измените на 5 * 60 * 1000 (5 минут) в production
	setInterval(flushStats, 30 * 1000);

	// Также сохраняем статистику при первом запуске через 5 секунд
	setTimeout(flushStats, 5000);

	const cleanupSessions = () => {
    const now = new Date();
    const timeout = 30 * 60 * 1000;
    
    activeSessions.forEach((session, sessionId) => {
        const lastActivity = new Date(session.lastActivity);
        if (now - lastActivity > timeout) {
            console.log(`🔴 Closing session: ${sessionId}`);
            activeSessions.delete(sessionId);
        }
    });
};

setInterval(cleanupSessions, 10 * 60 * 1000);

// ============================================
// API СТАТИСТИКИ
// ============================================

// Получить статистику за определённую дату (базовая)
app.get('/api/stats/:date', (req, res) => {
	try {
		const stats = readStats();
		
		// Проверка что stats.daily существует
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

// Получить детальную статистику за дату (с URL)
app.get('/api/stats/detailed/:date', (req, res) => {
		try {
			const stats = readStats();
			const dateKey = req.params.date;
			
			// Проверка что stats.daily существует
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
        
        // Форматируем данные
        const detailedSessions = dayStats.sessions.map(session => ({
            id: session.id,
            ip: session.ip,
            userAgent: session.userAgent,
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

// Получить сводку по всем датам
app.get('/api/stats/summary', (req, res) => {
    try {
        const stats = readStats();
        
        // Проверка что stats.daily существует
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

// Получить всю статистику (с принудительным сохранением)
app.get('/api/stats', (req, res) => {
    try {
        // Принудительно сохраняем текущие данные перед отправкой
        flushStats();
        res.json({ success: true, data: readStats() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Получить активные сессии (с принудительным сохранением)
app.get('/api/sessions/active', (req, res) => {
    try {
        // Принудительно сохраняем перед отправкой
        flushStats();
        res.json({ success: true, count: activeSessions.size, sessions: Array.from(activeSessions.values()) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// API ДЛЯ FAIRY-STOCKFISH (ПРАВИЛЬНАЯ ВЕРСИЯ)
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

        // Команды для движка с правильным вариантом
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

        // Таймаут 30 секунд
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

// Два маршрута для обратной совместимости
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
	console.log(`📁 Stats: ${path.resolve(statsFilePath)}`);
    console.log(`🎯 Engine: ${getEnginePath()}`);
    console.log(`\n📊 Available stats endpoints:`);
    console.log(`   GET /api/stats/summary - Сводка по всем датам`);
    console.log(`   GET /api/stats/detailed/:date - Детальная статистика за дату (с URL)`);
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
