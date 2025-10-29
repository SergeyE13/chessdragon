// Отправка позиции на бекенд
async function getBestMove(currentFen) {
    try {
        const response = await fetch('http://localhost:3000/get-best-move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                fen: currentFen,
                depth: 5 
            })
        });
        
        const result = await response.json();
        return result.bestMove;
    } catch (error) {
        console.error('Error getting best move:', error);
    }
}