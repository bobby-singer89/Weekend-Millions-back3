require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Telegraf } = require('telegraf');
const WebSocket = require('ws');

const app = express();

// Порт из Render (обязательно!)
const port = process.env.PORT || 3000;

// Запускаем сервер ОДИН раз
const server = app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
  console.log('PORT из env:', process.env.PORT || '(не задан, используется 3000)');
});

app.use(cors());
app.use(express.json());

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // для Neon обязательно
});

// Telegram-бот
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.on('text', (ctx) => {
  ctx.reply('Привет! Твой бот лотереи работает 🎉');
});

console.log('Telegram бот запущен!');

// WebSocket на том же сервере (без отдельного порта 8080)
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Клиент подключился к WebSocket');
  ws.on('close', () => console.log('Клиент отключился'));
});

// Функция рассылки обновления джекпота
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

// Покупка билетов
app.post('/buy-tickets', async (req, res) => {
  console.log('POST /buy-tickets');
  const { userId, tickets, txHash, paid } = req.body;

  if (userId == null || typeof userId !== 'number' || isNaN(userId)) {
    return res.status(400).json({ success: false, error: 'Неверный userId' });
  }

  if (!Array.isArray(tickets) || tickets.length === 0) {
    return res.status(400).json({ success: false, error: 'Нет билетов' });
  }

  try {
    const numericUserId = Number(userId);
    const ticketIds = [];

    for (const numbers of tickets) {
      if (!Array.isArray(numbers) || numbers.length !== 5) {
        return res.status(400).json({ success: false, error: 'Неверный билет' });
      }

      const result = await pool.query(
        'INSERT INTO tickets (user_id, numbers, tx_hash, paid) VALUES ($1, $2, $3, $4) RETURNING id',
        [numericUserId, numbers, txHash, paid || false]
      );

      ticketIds.push(result.rows[0].id);
    }

    broadcastJackpot();

    res.json({ success: true, ticketIds });
  } catch (error) {
    console.error('Ошибка /buy-tickets:', error.message || error);
    console.error('Стек:', error.stack);
    res.status(500).json({ success: false, error: error.message || 'Ошибка базы данных' });
  }
});

// ... (остальные эндпоинты /my-tickets, /draw, /draw-history, /jackpot — оставь как есть)

console.log('Сервер готов к работе!');