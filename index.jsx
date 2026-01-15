require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Telegraf } = require('telegraf');
const WebSocket = require('ws');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// Подключение к PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Telegram-бот
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.on('text', (ctx) => {
  ctx.reply('Привет! Твой бот лотереи работает 🎉');
});

console.log('Telegram бот запущен!');

// WebSocket сервер (порт 8080)
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  console.log('Клиент подключился к WebSocket');
  ws.on('close', () => console.log('Клиент отключился'));
});

// Функция рассылки обновления джекпота всем клиентам
const broadcastJackpot = async () => {
  try {
    const result = await pool.query('SELECT COUNT(*) AS total FROM tickets WHERE paid = true');
    const totalTickets = parseInt(result.rows[0].total, 10);
    
    // Начальный джекпот 1000 TON + 25% от всех оплаченных билетов
    const jackpot = 1000 + (totalTickets * 0.25);

    const data = { type: 'jackpotUpdate', jackpot };
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  } catch (error) {
    console.error('Ошибка рассылки джекпота:', error.message);
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

    // Рассылка обновления джекпота
    broadcastJackpot();

    res.json({ success: true, ticketIds });
  } catch (error) {
    console.error('Ошибка /buy-tickets:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Ошибка базы данных' });
  }
});

// История билетов пользователя
app.get('/my-tickets', async (req, res) => {
  const { userId } = req.query;

  if (!userId || isNaN(Number(userId))) {
    return res.status(400).json({ success: false, error: 'Неверный userId' });
  }

  const numericUserId = Number(userId);

  if (numericUserId === 0) {
    return res.json({ success: true, tickets: [] });
  }

  try {
    const result = await pool.query(
      'SELECT id, numbers, created_at, paid, tx_hash FROM tickets WHERE user_id = $1 ORDER BY created_at DESC',
      [numericUserId]
    );
    res.json({ success: true, tickets: result.rows });
  } catch (error) {
    console.error('Ошибка /my-tickets:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Розыгрыш
app.post('/draw', async (req, res) => {
  try {
    // Получаем все оплаченные билеты
    const ticketsResult = await pool.query(
      'SELECT id, user_id, numbers FROM tickets WHERE paid = true'
    );
    const tickets = ticketsResult.rows;

    if (tickets.length === 0) {
      return res.status(400).json({ success: false, error: 'Нет оплаченных билетов' });
    }

    // Генерируем выигрышные числа (5 уникальных от 1 до 33)
    const winningNumbers = [];
    while (winningNumbers.length < 5) {
      const num = Math.floor(Math.random() * 33) + 1;
      if (!winningNumbers.includes(num)) winningNumbers.push(num);
    }
    winningNumbers.sort((a, b) => a - b);

    // Считаем совпадения и призы
    const prizeDistribution = {
      5: 0.40,
      4: 0.30,
      3: 0.20,
      2: 0.08,
      1: 0.02
    };

    const winnersByMatches = {};
    for (let matches = 1; matches <= 5; matches++) {
      winnersByMatches[matches] = [];
    }

    tickets.forEach(ticket => {
      const matches = ticket.numbers.filter(num => winningNumbers.includes(num)).length;
      if (matches >= 1) {
        winnersByMatches[matches].push(ticket);
      }
    });

    // Расчёт призов
    const totalFund = tickets.length * 0.5; // 50% от билетов
    const prizes = {};
    for (let matches = 1; matches <= 5; matches++) {
      const percentage = prizeDistribution[matches] || 0;
      prizes[matches] = totalFund * percentage;
    }

    // Сохраняем розыгрыш
    const drawResult = await pool.query(
      'INSERT INTO draws (winning_numbers) VALUES ($1) RETURNING id',
      [winningNumbers]
    );
    const drawId = drawResult.rows[0].id;

    // Сохраняем результаты призов
    const prizeResults = [];
    for (let matches = 1; matches <= 5; matches++) {
      const winners = winnersByMatches[matches];
      if (winners.length > 0) {
        const prizePerWinner = prizes[matches] / winners.length;
        for (const winner of winners) {
          prizeResults.push({
            draw_id: drawId,
            ticket_id: winner.id,
            user_id: winner.user_id,
            matches,
            prize: prizePerWinner
          });

          // Уведомление победителю
          if (winner.user_id && winner.user_id !== 0) {
            try {
              await bot.telegram.sendMessage(
                winner.user_id,
                `🎉 Вы выиграли ${prizePerWinner.toFixed(2)} TON!\n` +
                `Совпадений: ${matches}\n` +
                `Выигрышные числа: ${winningNumbers.join(', ')}\n` +
                `Билет ID: ${winner.id}\n` +
                `Поздравляем!`
              );
            } catch (e) {
              console.error('Ошибка уведомления:', e);
            }
          }
        }
      }
    }

    // Сохраняем результаты призов в БД (новая таблица prize_results)
    for (const prize of prizeResults) {
      await pool.query(
        'INSERT INTO prize_results (draw_id, ticket_id, user_id, matches, prize) VALUES ($1, $2, $3, $4, $5)',
        [prize.draw_id, prize.ticket_id, prize.user_id, prize.matches, prize.prize]
      );
    }

    // Обновляем джекпот (обнуляем или оставляем начальный)
    broadcastJackpot();

    res.json({
      success: true,
      drawId,
      winningNumbers,
      winnersByMatches,
      prizes
    });
  } catch (error) {
    console.error('Ошибка розыгрыша:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// История розыгрышей
app.get('/draw-history', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, winning_numbers, winner_ticket_id, draw_date FROM draws ORDER BY draw_date DESC LIMIT 10'
    );
    res.json({ success: true, draws: result.rows });
  } catch (error) {
    console.error('Ошибка /draw-history:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Новый эндпоинт для джекпота (для начальной загрузки)
app.get('/jackpot', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) AS total FROM tickets WHERE paid = true');
    const totalTickets = parseInt(result.rows[0].total, 10);
    const jackpot = 1000 + (totalTickets * 0.25); // 1000 стартовых + 25%
    res.json({ success: true, jackpot });
  } catch (error) {
    console.error('Ошибка /jackpot:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Сервер запущен на http://localhost:${port}`);
});