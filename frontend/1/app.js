// Dragon Chess - Frontend с исправлением memory access error
const API_URL = 'http://localhost:3000';
let board = null;
let ffish = null;
let gameReady = false;
let playerColor = 'white';
let boardFlipped = false;
let lastMoveSquares = { from: null, to: null };
let selectedSquare = null;
let selectedDragon = null;
let currentDifficulty = 4;
let whiteDragons = 2;
let blackDragons = 2;

const difficultySettings = {
    1: { depth: 1 },
    2: { depth: 2 },
    3: { depth: 3 },
    4: { depth: 4 },
    5: { depth: 5 },
    6: { depth: 6 },
    7: { depth: 7 }
};

// Безопасный вызов методов board с защитой от memory errors
function safeBoardCall(callback, defaultValue = null) {
    try {
        if (!board || !gameReady) return defaultValue;
        return callback();
    } catch (error) {
        console.error('Board error:', error);
        if (error.message && error.message.includes('memory access')) {
            console.warn('Memory error detected, reinitializing...');
            setTimeout(() => initGame(), 100);
        }
        return defaultValue;
    }
}

// Initialize
async function initGame() {
    try {
        gameReady = false;
        
        // Если board уже существует, удаляем его
        if (board) {
            try {
                board.delete();
            } catch (e) {
                console.warn('Could not delete old board:', e);
            }
        }
        
        if (!ffish) {
            const Module = await import('https://cdn.jsdelivr.net/npm/ffish-es6@0.7.8/ffish.js');
            ffish = await Module.default({ 
                locateFile: (file) => `https://cdn.jsdelivr.net/npm/ffish-es6@0.7.8/${file}` 
            });
            
            const variantConfig = `
[Chess_dragon:chess]
dragon = d
customPiece1 = d:DA
startFen = rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[DDdd] w KQkq - 0 1
pieceDrops = true
dropPieceTypes = d
pocketSize = 2
whiteDropRegion = *1, *2
blackDropRegion = *7, *8
promotionPieceTypes = nbrqd
pieceValue = d:500
`;
            ffish.loadVariantConfig(variantConfig);
        }
        
        board = new ffish.Board('Chess_dragon');
        whiteDragons = 2;
        blackDragons = 2;
        lastMoveSquares = { from: null, to: null };
        selectedSquare = null;
        selectedDragon = null;
        
        gameReady = true;
        
        updateBoard();
        updatePockets();
        updateEvaluation();
        updateStatus();
        updateCoordinates();
        
    } catch (error) {
        console.error('Init error:', error);
        document.getElementById('status').textContent = 'Ошибка: ' + error.message;
        gameReady = false;
    }
}

// Get best move from server
async function getBestMoveFromEngine(fen, depth) {
    try {
        const response = await fetch(`${API_URL}/get-best-move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fen, depth })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        return { move: data.bestMove, info: null };
    } catch (error) {
        console.error('getBestMoveFromEngine error:', error);
        throw error;
    }
}

function makePlayerMove(move) {
    if (!gameReady) return;
    
    const fenBefore = safeBoardCall(() => board.fen(), '');
    const from = move.includes('@') ? null : move.substring(0, 2);
    const to = move.includes('@') ? move.substring(2) : move.substring(2, 4);
    
    const success = safeBoardCall(() => {
        board.push(move);
        return true;
    }, false);
    
    if (!success) {
        console.error('Failed to make move:', move);
        return;
    }
    
    if (move.startsWith('D@')) whiteDragons--;
    else if (move.startsWith('d@')) blackDragons--;
    
    lastMoveSquares = { from, to };
    selectedSquare = null;
    selectedDragon = null;
    
    updateBoard();
    updatePockets();
    updateEvaluation();
    
    const notation = formatMoveNotation(move, fenBefore);
    addToMoveHistory(notation, getMoveNumber(), 'white');
    updateStatus();
    
    const isOver = safeBoardCall(() => board.isGameOver(), false);
    if (isOver) {
        handleGameEnd();
        return;
    }
    
    setTimeout(() => makeComputerMove(), 300);
}

async function makeComputerMove() {
    if (!gameReady) return;
    
    const currentTurn = safeBoardCall(() => board.turn(), true);
    const isComputerTurn = (playerColor === 'white' && !currentTurn) || (playerColor === 'black' && currentTurn);
    
    const isOver = safeBoardCall(() => board.isGameOver(), false);
    if (!isComputerTurn || isOver) return;
    
    const thinkingDiv = document.getElementById('engine-thinking');
    const searchInfo = document.getElementById('search-info');
    thinkingDiv.classList.add('active');
    updateStatus();
    
    try {
        const fen = safeBoardCall(() => board.fen());
        if (!fen) {
            throw new Error('Could not get FEN');
        }
        
        const depth = difficultySettings[currentDifficulty].depth;
        const startTime = Date.now();
        const result = await getBestMoveFromEngine(fen, depth);
        const elapsed = Date.now() - startTime;
        
        if (result.info) {
            searchInfo.innerHTML = `Глубина: ${result.info.depth || depth} | Узлов: ${(result.info.nodes || 0).toLocaleString('ru-RU')} | Оценка: ${((result.info.score || 0) / 100).toFixed(2)}`;
        } else {
            searchInfo.innerHTML = `Глубина: ${depth} | Время: ${(elapsed / 1000).toFixed(1)}с`;
        }
        
        const move = result.move;
        const fenBefore = safeBoardCall(() => board.fen(), '');
        const from = move.includes('@') ? null : move.substring(0, 2);
        const to = move.includes('@') ? move.substring(2) : move.substring(2, 4);
        
        const success = safeBoardCall(() => {
            board.push(move);
            return true;
        }, false);
        
        if (!success) {
            throw new Error('Failed to execute move: ' + move);
        }
        
        if (move.startsWith('D@')) whiteDragons--;
        else if (move.startsWith('d@')) blackDragons--;
        
        lastMoveSquares = { from, to };
        
        updateBoard();
        updatePockets();
        updateEvaluation();
        
        const notation = formatMoveNotation(move, fenBefore);
        addToMoveHistory(notation, getMoveNumber(), 'black');
        
        setTimeout(() => {
            thinkingDiv.classList.remove('active');
        }, 800);
        
        updateStatus();
        
        const isGameOver = safeBoardCall(() => board.isGameOver(), false);
        if (isGameOver) handleGameEnd();
        
    } catch (error) {
        console.error('Engine error:', error);
        document.getElementById('status').textContent = 'Ошибка движка: ' + error.message;
        thinkingDiv.classList.remove('active');
    }
}

function updateBoard() {
    const boardDiv = document.getElementById('board');
    if (!boardDiv) return;
    
    boardDiv.innerHTML = '';
    
    const fen = safeBoardCall(() => board.fen());
    if (!fen) {
        console.error('Cannot get FEN');
        return;
    }
    
    if (!boardFlipped) {
        for (let rank = 8; rank >= 1; rank--) {
            for (let file = 0; file < 8; file++) {
                const fileChar = String.fromCharCode(97 + file);
                const square = fileChar + rank;
                createSquare(square, fen);
            }
        }
    } else {
        for (let rank = 1; rank <= 8; rank++) {
            for (let file = 7; file >= 0; file--) {
                const fileChar = String.fromCharCode(97 + file);
                const square = fileChar + rank;
                createSquare(square, fen);
            }
        }
    }
    
    highlightLastMove();
}

function createSquare(square, fen) {
    const squareDiv = document.createElement('div');
    const file = square.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(square[1]) - 1;
    const isLight = (file + rank) % 2 === 0;
    
    squareDiv.className = `square ${isLight ? 'light' : 'dark'}`;
    squareDiv.dataset.square = square;
    
    const piece = getPieceAtSquare(fen, square);
    if (piece) {
        const pieceSpan = document.createElement('span');
        pieceSpan.className = 'piece';
        pieceSpan.textContent = getPieceSymbol(piece);
        squareDiv.appendChild(pieceSpan);
    }
    
    squareDiv.addEventListener('click', () => handleSquareClick(square));
    document.getElementById('board').appendChild(squareDiv);
}

function handleSquareClick(square) {
    if (!gameReady) return;
    
    const currentTurn = safeBoardCall(() => board.turn(), true);
    const isPlayerTurn = (playerColor === 'white' && currentTurn) || (playerColor === 'black' && !currentTurn);
    
    if (!isPlayerTurn) return;
    
    const legalMovesStr = safeBoardCall(() => board.legalMoves(), '');
    const legalMoves = legalMovesStr.split(' ').filter(m => m);
    
    if (selectedSquare) {
        const move = selectedSquare + square;
        if (legalMoves.includes(move)) {
            makePlayerMove(move);
            return;
        }
        
        const promotions = ['q', 'r', 'b', 'n', 'd'];
        for (let promo of promotions) {
            if (legalMoves.includes(move + promo)) {
                showPromotionDialog(move);
                return;
            }
        }
    }
    
    if (selectedDragon) {
        const dragonLetter = selectedDragon === 'white' ? 'D' : 'd';
        const dropMove = dragonLetter + '@' + square;
        if (legalMoves.includes(dropMove)) {
            makePlayerMove(dropMove);
            return;
        }
    }
    
    const fen = safeBoardCall(() => board.fen(), '');
    const piece = getPieceAtSquare(fen, square);
    if (piece && ((playerColor === 'white' && piece === piece.toUpperCase()) || (playerColor === 'black' && piece === piece.toLowerCase()))) {
        selectedSquare = square;
        selectedDragon = null;
        updateBoard();
        highlightLegalMoves(square);
    }
}

function highlightLegalMoves(fromSquare) {
    const legalMovesStr = safeBoardCall(() => board.legalMoves(), '');
    const legalMoves = legalMovesStr.split(' ').filter(m => m);
    const movesFromSquare = legalMoves.filter(m => m.startsWith(fromSquare));
    
    movesFromSquare.forEach(move => {
        const to = move.substring(2, 4);
        const squareEl = document.querySelector(`[data-square="${to}"]`);
        if (squareEl) {
            squareEl.classList.add('legal-move');
            const fen = safeBoardCall(() => board.fen(), '');
            const hasPiece = getPieceAtSquare(fen, to) !== null;
            if (hasPiece) squareEl.classList.add('has-piece');
        }
    });
}

function highlightLastMove() {
    if (lastMoveSquares.from) {
        const fromEl = document.querySelector(`[data-square="${lastMoveSquares.from}"]`);
        if (fromEl) fromEl.classList.add('last-move');
    }
    if (lastMoveSquares.to) {
        const toEl = document.querySelector(`[data-square="${lastMoveSquares.to}"]`);
        if (toEl) toEl.classList.add('last-move');
    }
}

function updatePockets() {
    const whiteP = document.getElementById('white-pocket');
    const blackP = document.getElementById('black-pocket');
    if (whiteP) whiteP.textContent = '♤'.repeat(whiteDragons) || '—';
    if (blackP) blackP.textContent = '♠'.repeat(blackDragons) || '—';
}

function updateEvaluation() {
    const fen = safeBoardCall(() => board.fen());
    if (!fen) return;
    
    const boardStr = fen.split(' ')[0].split('[')[0];
    let score = 0;
    const values = {'P':100,'N':320,'B':330,'R':500,'Q':900,'D':500,'p':-100,'n':-320,'b':-330,'r':-500,'q':-900,'d':-500};
    
    for (let char of boardStr) {
        if (values[char]) score += values[char];
    }
    
    const evalText = document.getElementById('evaluation-text');
    const evalFill = document.getElementById('evaluation-fill');
    
    if (evalText && evalFill) {
        const displayScore = (score / 100).toFixed(1);
        evalText.textContent = score > 0 ? `+${displayScore}` : displayScore;
        evalText.classList.remove('positive', 'negative');
        if (score > 0) evalText.classList.add('positive');
        else if (score < 0) evalText.classList.add('negative');
        
        const maxScore = 1000;
        const clampedScore = Math.max(-maxScore, Math.min(maxScore, score));
        const percentage = ((clampedScore / maxScore) + 1) * 50;
        evalFill.style.height = `${percentage}%`;
    }
}

function updateStatus() {
    const statusDiv = document.getElementById('status');
    if (!statusDiv) return;
    
    if (!gameReady) {
        statusDiv.textContent = 'Загрузка...';
        return;
    }
    
    const turn = safeBoardCall(() => board.turn(), true);
    const isPlayerTurn = (playerColor === 'white' && turn) || (playerColor === 'black' && !turn);
    const colorName = playerColor === 'white' ? 'белые' : 'чёрные';
    
    const isOver = safeBoardCall(() => board.isGameOver(), false);
    const isCheck = safeBoardCall(() => board.isCheck(), false);
    
    if (isOver) {
        if (isCheck) {
            const winner = turn ? 'чёрные' : 'белые';
            statusDiv.textContent = `Мат! Победили ${winner}`;
        } else {
            statusDiv.textContent = 'Пат - ничья';
        }
    } else if (isCheck) {
        statusDiv.textContent = 'Шах!';
    } else if (isPlayerTurn) {
        statusDiv.textContent = `Ваш ход (${colorName})`;
    } else {
        statusDiv.textContent = 'Ход компьютера...';
    }
}

function updateCoordinates() {
    const fileLabels = boardFlipped ? ['h','g','f','e','d','c','b','a'] : ['a','b','c','d','e','f','g','h'];
    const rankLabels = boardFlipped ? ['1','2','3','4','5','6','7','8'] : ['8','7','6','5','4','3','2','1'];
    
    const fileLabelsDiv = document.getElementById('file-labels');
    const rankLabelsDiv = document.getElementById('rank-labels');
    
    if (fileLabelsDiv) {
        fileLabelsDiv.innerHTML = fileLabels.map(f => `<span>${f}</span>`).join('');
    }
    if (rankLabelsDiv) {
        rankLabelsDiv.innerHTML = rankLabels.map(r => `<span>${r}</span>`).join('');
    }
}

function getPieceAtSquare(fen, square) {
    const parts = fen.split(' ');
    const position = parts[0].split('[')[0];
    const ranks = position.split('/');
    
    const file = square.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = 8 - parseInt(square[1]);
    
    if (rank < 0 || rank >= 8) return null;
    
    let fileIndex = 0;
    for (let char of ranks[rank]) {
        if (char >= '1' && char <= '8') {
            fileIndex += parseInt(char);
        } else {
            if (fileIndex === file) return char;
            fileIndex++;
        }
    }
    return null;
}

function getPieceSymbol(piece) {
    const symbols = {
        'P': '♙', 'N': '♘', 'B': '♗', 'R': '♖', 'Q': '♕', 'K': '♔', 'D': '♤',
        'p': '♟', 'n': '♞', 'b': '♝', 'r': '♜', 'q': '♛', 'k': '♚', 'd': '♠'
    };
    return symbols[piece] || piece;
}

function formatMoveNotation(move, fenBefore) {
    if (move.includes('@')) {
        const piece = move[0] === 'D' ? '♤' : '♠';
        const square = move.substring(2);
        return `${piece}@${square}`;
    }
    
    const from = move.substring(0, 2);
    const to = move.substring(2, 4);
    const piece = getPieceAtSquare(fenBefore, from);
    const symbol = piece ? getPieceSymbol(piece) : '';
    
    return `${symbol}${from}-${to}`;
}

function getMoveNumber() {
    const fen = safeBoardCall(() => board.fen(), '');
    if (!fen) return 1;
    const parts = fen.split(' ');
    return parseInt(parts[parts.length - 1]) || 1;
}

let moveHistoryData = [];

function addToMoveHistory(notation, moveNum, color) {
    if (color === 'white') {
        moveHistoryData.push({ number: moveNum, white: notation, black: '' });
    } else {
        if (moveHistoryData.length > 0) {
            moveHistoryData[moveHistoryData.length - 1].black = notation;
        }
    }
    renderMoveHistory();
}

function renderMoveHistory() {
    const historyDiv = document.getElementById('move-history');
    if (!historyDiv) return;
    
    historyDiv.innerHTML = moveHistoryData.map(m => 
        `<div class="move-pair">
            <span class="move-number">${m.number}.</span>
            <span class="move">${m.white}</span>
            <span class="move">${m.black}</span>
        </div>`
    ).join('');
}

function handleGameEnd() {
    setTimeout(() => {
        const turn = safeBoardCall(() => board.turn(), true);
        const isCheck = safeBoardCall(() => board.isCheck(), false);
        
        if (isCheck) {
            const winner = turn ? 'Чёрные' : 'Белые';
            alert(`Мат! ${winner} победили!`);
        } else {
            alert('Пат! Ничья.');
        }
    }, 500);
}

function showPromotionDialog(movePrefix) {
    // Простая реализация - по умолчанию ферзь
    makePlayerMove(movePrefix + 'q');
}

function selectDragon(color) {
    if (!gameReady) return;
    
    const turn = safeBoardCall(() => board.turn(), true);
    const isPlayerTurn = (playerColor === 'white' && turn) || (playerColor === 'black' && !turn);
    
    if (!isPlayerTurn) return;
    if (color === 'white' && whiteDragons === 0) return;
    if (color === 'black' && blackDragons === 0) return;
    if ((color === 'white' && playerColor !== 'white') || (color === 'black' && playerColor !== 'black')) return;
    
    selectedDragon = color;
    selectedSquare = null;
    
    document.querySelectorAll('.pocket-pieces').forEach(p => p.classList.remove('selected'));
    document.getElementById(`${color}-pocket`).classList.add('selected');
}

function newGame() {
    moveHistoryData = [];
    initGame();
}

function flipBoard() {
    playerColor = playerColor === 'white' ? 'black' : 'white';
    boardFlipped = !boardFlipped;
    updateBoard();
    updateCoordinates();
    updateStatus();
    
    const turn = safeBoardCall(() => board.turn(), true);
    const isComputerTurn = (playerColor === 'white' && !turn) || (playerColor === 'black' && turn);
    
    if (isComputerTurn) {
        setTimeout(() => makeComputerMove(), 300);
    }
}

function undoMove() {
    // Простая реализация - перезапуск игры
    if (confirm('Отменить последний ход? (перезапустит игру)')) {
        newGame();
    }
}

function setDifficulty(level) {
    currentDifficulty = parseInt(level);
}
