const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

// Определяем путь к движку в зависимости от платформы
function getEnginePath() {
    if (process.platform === 'win32') {
        return path.join(__dirname, 'engines', 'fairy-stockfish-windows.exe');
    } else {
        return path.join(__dirname, 'engines', 'fairy-stockfish-linux');
    }
}

app.post('/get-best-move', async (req, res) => {
    const { fen, depth = 15 } = req.body;
    
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

    for (const cmd of commands) {
        engine.stdin.write(cmd + '\n');
    }

    engine.stdout.on('data', (data) => {
        const output = data.toString();
        analysis += output;
        
        // Ищем строку с лучшим ходом
        if (output.includes('bestmove')) {
            const match = output.match(/bestmove\s+(\S+)/);
            if (match) {
                bestMove = match[1];
                engine.stdin.write('quit\n');
            }
        }
    });

    engine.on('close', () => {
        res.json({ 
            bestMove, 
            analysis: analysis.split('\n').filter(line => line.trim()) 
        });
    });

    // Таймаут на случай ошибок
    setTimeout(() => {
        if (!bestMove) {
            engine.kill();
            res.status(500).json({ error: 'Engine timeout' });
        }
    }, 30000);
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});