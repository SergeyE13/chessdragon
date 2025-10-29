const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const cors = require('cors');  // Добавьте эту строку

const app = express();

// Добавьте CORS middleware
app.use(cors());
app.use(express.json());

// Определяем путь к движку в зависимости от платформы
function getEnginePath() {
    if (process.platform === 'win32') {
        return path.join(__dirname, 'engines', 'fairy-stockfish-largeboard_x86-64.exe');
    } else {
        return path.join(__dirname, 'engines', 'fairy-stockfish-largeboard_x86-64');
    }
}

// Добавьте endpoint для проверки здоровья сервера
app.get('/health', (req, res) => {
    res.json({ status: 'Server is running', timestamp: new Date().toISOString() });
});

app.post('/get-best-move', async (req, res) => {
    console.log('Received request with FEN:', req.body.fen);
    
    const { fen, depth = 15 } = req.body;
    
    // Проверка наличия FEN
    if (!fen) {
        return res.status(400).json({ error: 'FEN is required' });
    }

    try {
        const engine = spawn(getEnginePath(), [], { 
            stdio: ['pipe', 'pipe', 'pipe'] 
        });

        let bestMove = null;
        let analysis = '';

        // Настройка движка
        const commands = [
            'uci',
            `setoption name UCI_Variant value chessdragon`,
            `setoption name VariantPath value ${path.join(__dirname, 'variants', 'chessdragon.ini')}`,
            `position fen ${fen}`,
            `go depth ${depth}`
        ];

        console.log('Sending commands to engine:', commands);

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
                    console.log('Found best move:', bestMove);
                    engine.stdin.write('quit\n');
                    
                    // Отправляем ответ сразу при нахождении хода
                    res.json({ 
                        bestMove, 
                        analysis: analysis.split('\n').filter(line => line.trim()) 
                    });
                }
            }
        });

        engine.stderr.on('data', (data) => {
            console.error('Engine stderr:', data.toString());
        });

        engine.on('close', (code) => {
            console.log(`Engine process exited with code ${code}`);
            if (!bestMove) {
                res.status(500).json({ error: 'Engine closed without providing best move', analysis });
            }
        });

        engine.on('error', (error) => {
            console.error('Engine error:', error);
            res.status(500).json({ error: `Engine error: ${error.message}` });
        });

        // Таймаут на случай ошибок
        setTimeout(() => {
            if (!bestMove && !res.headersSent) {
                console.log('Engine timeout');
                engine.kill();
                res.status(500).json({ error: 'Engine timeout' });
            }
        }, 30000);

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: `Server error: ${error.message}` });
    }
});

app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
    console.log('Health check available at http://localhost:3000/health');
});