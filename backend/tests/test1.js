//тест прослушивания порта
const express = require('express');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Приложение работает на http://localhost:${port}`);
});


//http://localhost:3000/