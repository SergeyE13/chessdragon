const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const statsFilePath = path.join(__dirname, 'stats.json');

const app = express();
const PORT = process.env.PORT || 3000;

// Функция для чтения статистики
const readStats = () => {
    try {
        if (fs.existsSync(statsFilePath)) {
            const data = fs.readFileSync(statsFilePath, 'utf8');
            console.log('📊 Stats file content:', data);
            return JSON.parse(data);
        } else {
            console.log('📊 Stats file does not exist');
            return {};
        }
    } catch (err) {
        console.error('❌ Error reading stats:', err);
        return {};
    }
};

// Функция для сохранения статистики
const dumpStats = (stats) => {
    try {
        fs.writeFileSync(statsFilePath, JSON.stringify(stats, null, 2));
        console.log('💾 Stats saved successfully');
    } catch (err) {
        console.error('❌ Error saving stats:', err);
    }
};

app.use(cors());
app.use(express.json());

// Раздаем статические файлы фронтенда
app.use(express.static(path.join(__dirname, '../frontend')));


function getEnginePath() {
    if (process.platform === 'win32') {
        return path.join(__dirname, 'engines', 'fairy-stockfish-largeboard_x86-64.exe');
    } else {
        return path.join(__dirname, 'engines', 'fairy-stockfish-largeboard_x86-64');
    }
}

// Middleware для подсчета запросов
app.use((req, res, next) => {
    const originalSend = res.send;
    const originalJson = res.json;
    
    res.on('finish', () => {
        try {
            const stats = readStats();
            const today = new Date().toISOString().split('T')[0];
            const route = req.route ? req.route.path : req.path;
            const event = `${req.method} ${route} ${res.statusCode}`;
            
            console.log(`📈 Recording event: ${event} for date: ${today}`);
            
            // Инициализация счетчиков
            if (!stats[today]) {
                stats[today] = {};
                console.log(`🆕 Created new day: ${today}`);
            }
            if (!stats[today][event]) {
                stats[today][event] = 0;
            }
            
            stats[today][event] += 1;
            console.log(`🔢 Updated count for ${event}: ${stats[today][event]}`);
            
            dumpStats(stats);
            console.log('📋 Current stats:', stats);
            
        } catch (error) {
            console.error('❌ Error in stats middleware:', error);
        }
    });
    next();
});

// Endpoint для проверки файловой системы
app.get('/debug-fs', (req, res) => {
    const files = fs.readdirSync(__dirname);
    const fileInfo = files.map(file => {
        const filePath = path.join(__dirname, file);
        try {
            const stats = fs.statSync(filePath);
            return {
                name: file,
                isFile: stats.isFile(),
                size: stats.size,
                modified: stats.mtime
            };
        } catch (err) {
            return { name: file, error: err.message };
        }
    });
    
    res.json({
        currentDir: __dirname,
        files: fileInfo,
        statsFileExists: fs.existsSync(statsFilePath),
        statsFileContent: readStats()
    });
});

// Endpoint для принудительной записи тестовых данных
app.post('/test-stats', (req, res) => {
    const stats = readStats();
    const today = new Date().toISOString().split('T')[0];
    
    if (!stats[today]) stats[today] = {};
    
    // Добавляем тестовые данные
    stats[today]['GET /test-stats 200'] = (stats[today]['GET /test-stats 200'] || 0) + 1;
    stats[today]['POST /get-best-move 200'] = (stats[today]['POST /get-best-move 200'] || 0) + 5;
    
    dumpStats(stats);
    
    res.json({
        message: 'Test stats added',
        currentStats: stats
    });
});

app.post('/get-best-move', async (req, res) => {
    console.log('Received request with FEN:', req.body.fen);
    
    const { fen, depth = 10 } = req.body;
    
    if (!fen) {
        return res.status(400).json({ error: 'FEN is required' });
    }

    try {
        const engine = spawn(getEnginePath(), [], { 
            stdio: ['pipe', 'pipe', 'pipe'] 
        });

        let bestMove = null;
        let analysis = '';
        let engineReady = false;
        let positionSet = false;

        // Обработка вывода движка
        engine.stdout.on('data', (data) => {
            const output = data.toString();
            console.log('Engine output:', output);
            analysis += output;
            
            if (output.includes('uciok')) {
                engineReady = true;
                console.log('Engine is ready');
                
                // После получения uciok настраиваем вариант
                const setupCommands = [
                    `setoption name VariantPath value ${path.join(__dirname, 'variants', 'chessdragon.ini')}`,
                    `setoption name UCI_Variant value chessdragon`,
                    'isready'
                ];
                
                setupCommands.forEach(cmd => {
                    console.log('Sending setup command:', cmd);
                    engine.stdin.write(cmd + '\n');
                });
            }
            
            if (output.includes('readyok') && !positionSet) {
                positionSet = true;
                console.log('Engine is ready for position');
                
                // Устанавливаем позицию и запускаем анализ
                const analysisCommands = [
                    `position fen ${fen}`,
                    `go depth ${depth}`
                ];
                
                analysisCommands.forEach(cmd => {
                    console.log('Sending analysis command:', cmd);
                    engine.stdin.write(cmd + '\n');
                });
            }
            
            // Ищем строку с лучшим ходом
            if (output.includes('bestmove')) {
                const match = output.match(/bestmove\s+(\S+)/);
                if (match) {
                    bestMove = match[1];
                    console.log('Found best move:', bestMove);
                    
                    // Отправляем ответ
                    res.json({ 
                        bestMove, 
                        analysis: analysis.split('\n').filter(line => line.trim()) 
                    });
                    
                    // Завершаем движок
                    engine.stdin.write('quit\n');			
					
                }
            }
            
            // Обработка ошибок движка
            if (output.includes('Illegal move') || output.includes('Invalid') || output.includes('Error')) {
                console.error('Engine error detected:', output);
                if (!res.headersSent) {
                    res.status(400).json({ 
                        error: 'Invalid position or move',
                        details: output,
                        analysis: analysis.split('\n').filter(line => line.trim())
                    });
                }
                engine.stdin.write('quit\n');
            }
        });

        engine.stderr.on('data', (data) => {
            console.error('Engine stderr:', data.toString());
        });

        engine.on('close', (code) => {
            console.log(`Engine process exited with code ${code}`);
            if (!bestMove && !res.headersSent) {
                res.status(500).json({ 
                    error: 'Engine closed without providing best move',
                    exitCode: code,
                    analysis: analysis.split('\n').filter(line => line.trim())
                });
            }
        });

        engine.on('error', (error) => {
            console.error('Engine spawn error:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: `Engine error: ${error.message}` });
            }
        });

        // Инициализация движка
        console.log('Starting engine initialization...');
        engine.stdin.write('uci\n');

        // Таймаут
        setTimeout(() => {
            if (!bestMove && !res.headersSent) {
                console.log('Engine timeout reached');
                engine.kill();
                res.status(500).json({ error: 'Engine timeout - no response within 30 seconds' });
            }
        }, 30000);

    } catch (error) {
        console.error('Server error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: `Server error: ${error.message}` });
        }
    }
});

// Добавьте в server.js
app.get('/test-variant', (req, res) => {
    const engine = spawn(getEnginePath(), [], { 
        stdio: ['pipe', 'pipe', 'pipe'] 
    });

    let output = '';
    
    const commands = [
        'uci',
        `setoption name VariantPath value ${path.join(__dirname, 'variants', 'chessdragon.ini')}`,
        `setoption name UCI_Variant value chessdragon`,
        'isready',
        'position startpos',
        'go depth 3'
    ];

    commands.forEach(cmd => engine.stdin.write(cmd + '\n'));

    engine.stdout.on('data', (data) => {
        output += data.toString();
        if (data.toString().includes('bestmove')) {
            engine.stdin.write('quit\n');
            res.json({ status: 'Variant works correctly', output: output.split('\n') });
        }
    });

    setTimeout(() => {
        engine.kill();
        res.status(500).json({ error: 'Variant test timeout', output: output.split('\n') });
    }, 10000);
});

// Ваши API роуты
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from Render!' });
});

// Добавьте endpoint для получения статистики
app.get('/api/stats', (req, res) => {
    res.json(readStats());
});

app.get('/admin/stats', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/stats.html'));
});

app.get('/admin/stats-chart', (req, res) => {
    const stats = readStats();
    
    // Подготовка данных за последние 7 дней
    const dates = [];
    const moveCounts = [];
    
    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        dates.push(dateStr);
        
        const dayStats = stats[dateStr] || {};
        const moves = dayStats['POST /get-best-move 200'] || 0;
        moveCounts.push(moves);
    }
    
    // Генерация URL для QuickChart
    const chartUrl = `https://quickchart.io/chart?c={
        type: 'line',
        data: {
            labels: ${JSON.stringify(dates)},
            datasets: [{
                label: 'Запросов лучшего хода',
                data: ${JSON.stringify(moveCounts)},
                borderColor: 'rgb(75, 192, 192)',
                tension: 0.1
            }]
        },
        options: {
            title: {
                display: true,
                text: 'Активность пользователей за 7 дней'
            }
        }
    }`;
    
    res.redirect(chartUrl);
});

// Все остальные запросы отправляем на фронтенд
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

//app.listen(3000, () => {
//    console.log('Server running on http://localhost:3000');
});