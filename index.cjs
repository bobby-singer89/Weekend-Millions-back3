require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Telegraf } = require('telegraf');
const WebSocket = require('ws');

const app = express();

// Порт ТОЛЬКО из env (Render сам подставит свой)
const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
  console.log('PORT из env:', process.env.PORT || '(не задан, используется 3000)');
});

app.use(cors());
app.use(express.json());

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Telegram-бот
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.on('text', (ctx) => {
  ctx.reply('Привет! Твой бот лотереи работает 🎉');
});

console.log('Telegram бот запущен!');

// WebSocket на том же сервере
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Клиент подключился к WebSocket');
  ws.on('close', () => console.log('Клиент отключился'));
});

// Функция рассылки джекпота (оставил как есть)
const broadcastJackpot = async () => {
  try {
    const result = await pool.query('SELECT COUNT(*) AS total FROM tickets WHERE paid = true');
    const totalTickets = parseInt(result.rows[0].total, 10);
    const jackpot = 1000 + (totalTickets * 0.25);

    const data = { type: 'jackpotUpdate', jackpot };
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  } catch (error) {
    console.error('Ошибка рассылки джекпота:', error.message || error);
    console.error('Стек:', error.stack);
  }
};

// Твои эндпоинты (все оставлены без изменений)
app.post('/buy-tickets', async (req, res) => {
  // ... твой код ...
});

app.get('/my-tickets', async (req, res) => {
  // ... твой код ...
});

app.post('/draw', async (req, res) => {
  // ... твой код ...
});

app.get('/draw-history', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, winning_numbers, winner_ticket_id, draw_date FROM draws ORDER BY draw_date DESC LIMIT 10'
    );
    res.json({ success: true, draws: result.rows });
  } catch (error) {
    console.error('Ошибка /draw-history:', error.message || error);
    console.error('Стек:', error.stack);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/jackpot', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) AS total FROM tickets WHERE paid = true');
    const totalTickets = parseInt(result.rows[0].total, 10);
    const jackpot = 1000 + (totalTickets * 0.25);
    res.json({ success: true, jackpot });
  } catch (error) {
    console.error('Ошибка /jackpot:', error.message || error);
    console.error('Стек:', error.stack);
    res.status(500).json({ success: false, error: error.message || 'Database error' });
  }
});

console.log('Сервер готов к работе!');