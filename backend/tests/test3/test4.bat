rem curl -X POST http://localhost:3000/get-best-move -H "Content-Type: application/json" -d "{\"fen\":\"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[DDdd] w KQkq - 0 1\",\"depth\":10}"
rem curl -X POST http://localhost:3000/get-best-move -H "Content-Type: application/json" -d "{\"fen\":\"rnbqkbnr/pppppppp/8/8/8/8/PPPPDPPP/RNBQKBNR[Ddd] w KQkq - 0 1\",\"depth\":10}"
rem curl -X POST http://localhost:3000/get-best-move -H "Content-Type: application/json"  -d "{\"fen\":\"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[DDdd] w KQkq - 0 1\",\"depth\":10}"
rem curl -X POST https://chessdragon.onrender.com/get-best-move -H "Content-Type: application/json"  -d "{\"fen\":\"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[DDdd] w KQkq - 0 1\",\"depth\":10}"
rem /get-best-move, /test-variant, /api/data
curl -X GET https://chessdragon.onrender.com/api/data -H "Content-Type: application/json" 
rem curl -X GET https://chessdragon.onrender.com/test-variant