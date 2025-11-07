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
        fs.writeFileSync(statsFilePath, JSON.stringify(stats, null, 2));
        console.log('💾 Stats saved');
    } catch (err) {
        console.error('❌ Error saving stats:', err);
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
        const stats = readStats();
        const now = new Date();
        const dateKey = getDateKey(now);
        
        if (!stats.daily[dateKey]) {
            stats.daily[dateKey] = {
                date: dateKey,
                totalRequests: 0,
                uniqueIPs: new Set(),
                sessions: []
            };
        }
        
        const dailyStats = stats.daily[dateKey];
        
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

setInterval(flushStats, 5 * 60 * 1000);

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

app.get('/api/stats/:date', (req, res) => {
    try {
        const stats = readStats();
        if (stats.daily[req.params.date]) {
            res.json({ success: true, date: req.params.date, data: stats.daily[req.params.date] });
        } else {
            res.status(404).json({ success: false, message: 'No data for this date' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        res.json({ success: true, data: readStats() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/sessions/active', (req, res) => {
    try {
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
    
    const { fen, depth = 10 } = req.body;
    
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
		//temporary
		//console.log('VARIANT PATH:', path.resolve(__dirname, 'variants', 'chessdragon.ini'));
		

        for (const cmd of commands) {
            engine.stdin.write(cmd + '\n');
        }

        engine.stdout.on('data', (data) => {
            const output = data.toString();
            console.log('Engine output:', output);
            analysis += output;
 
			// Ищем строку с лучшим ходом 
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
            const errorOutput = data.toString();
            console.error('❌ Engine stderr:', errorOutput);
            analysis += '\nSTDERR: ' + errorOutput;
        });

        engine.on('close', (code) => {
            console.log(`Engine closed with code ${code}`);
            if (!bestMove && !res.headersSent) {
                console.error('❌ No best move found. Analysis:', analysis);
                res.status(500).json({ 
                    error: 'Engine closed without best move', 
                    code,
                    analysis: analysis.split('\n').filter(line => line.trim()),
                    fen: fen
                });
            }
        });

        engine.on('error', (error) => {
            console.error('❌ Engine error:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: `Engine error: ${error.message}` });
            }
        });

        // Таймаут 60 секунд (увеличен для отладки)
        setTimeout(() => {
            if (!bestMove && !res.headersSent) {
                console.log('⏱️ Engine timeout');
                console.log('Analysis at timeout:', analysis);
                engine.kill();
                res.status(500).json({ 
                    error: 'Engine timeout',
                    analysis: analysis.split('\n').filter(line => line.trim()),
                    fen: fen
                });
            }
        }, 60000);

    } catch (error) {
        console.error('❌ Server error:', error);
        res.status(500).json({ error: `Server error: ${error.message}` });
    }
};

// Два маршрута для обратной совместимости
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
    console.log(`🎯 Engine: ${getEnginePath()}`);
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
