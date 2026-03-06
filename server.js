/**
 * server.js — Бэкенд для многопользовательского FPS в стиле DOOM
 * Технологии: Express, PostgreSQL (pg), bcrypt, Socket.IO
 */

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const path       = require('path');

// ──────────────────────────────────────────────
//  Настройка Express + HTTP + Socket.IO
// ──────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
// Раздаём index.html из той же папки
app.use(express.static(path.join(__dirname)));

// ──────────────────────────────────────────────
//  Подключение к PostgreSQL
//  Измените параметры под свою БД
// ──────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DB,
  user:     process.env.PG_USER,
  password: process.env.PG_PASS,
});

// ──────────────────────────────────────────────
//  Авто-создание таблицы users при запуске
// ──────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id       SERIAL PRIMARY KEY,
        username VARCHAR(32) UNIQUE NOT NULL,
        password TEXT NOT NULL
      );
    `);
    console.log('[БД] Таблица users готова.');
  } catch (err) {
    console.error('[БД] Ошибка инициализации:', err.message);
    process.exit(1);
  }
}

// ──────────────────────────────────────────────
//  REST API — Регистрация
// ──────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль.' });
  }
  if (username.length < 3 || username.length > 32) {
    return res.status(400).json({ error: 'Логин: от 3 до 32 символов.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Пароль: минимум 4 символа.' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username',
      [username.trim(), hash]
    );
    console.log(`[API] Зарегистрирован: ${username}`);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Этот никнейм уже занят.' });
    }
    console.error('[API] Ошибка регистрации:', err.message);
    res.status(500).json({ error: 'Ошибка сервера.' });
  }
});

// ──────────────────────────────────────────────
//  REST API — Вход
// ──────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль.' });
  }
  try {
    const result = await pool.query(
      'SELECT id, username, password FROM users WHERE username = $1',
      [username.trim()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный логин или пароль.' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный логин или пароль.' });
    }
    console.log(`[API] Вход: ${username}`);
    res.json({ success: true, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('[API] Ошибка входа:', err.message);
    res.status(500).json({ error: 'Ошибка сервера.' });
  }
});

// ──────────────────────────────────────────────
//  Игровое состояние (в памяти)
// ──────────────────────────────────────────────

/** Возможные точки респауна на арене */
const SPAWN_POINTS = [
  { x:  0,   y: 1.8, z:  0   },
  { x:  20,  y: 1.8, z:  20  },
  { x: -20,  y: 1.8, z:  20  },
  { x:  20,  y: 1.8, z: -20  },
  { x: -20,  y: 1.8, z: -20  },
  { x:  35,  y: 1.8, z:   0  },
  { x: -35,  y: 1.8, z:   0  },
  { x:   0,  y: 1.8, z:  35  },
  { x:   0,  y: 1.8, z: -35  },
];

function randomSpawn() {
  return SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
}

// players[socketId] = { id, username, x, y, z, rotY, health, kills, deaths }
const players = {};

// ──────────────────────────────────────────────
//  Socket.IO — Мультиплеер
// ──────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Подключён: ${socket.id}`);

  // ── Игрок входит в игру после авторизации ──
  socket.on('joinGame', ({ username }) => {
    const spawn = randomSpawn();
    players[socket.id] = {
      id:       socket.id,
      username: username,
      x:        spawn.x,
      y:        spawn.y,
      z:        spawn.z,
      rotY:     0,
      health:   100,
      kills:    0,
      deaths:   0,
    };
    console.log(`[Game] ${username} вошёл в игру.`);

    // Отправляем новому игроку список всех текущих игроков
    socket.emit('currentPlayers', Object.values(players));

    // Оповещаем всех остальных о новом игроке
    socket.broadcast.emit('newPlayer', players[socket.id]);
  });

  // ── Обновление позиции и поворота ──
  socket.on('playerMove', ({ x, y, z, rotY }) => {
    if (!players[socket.id]) return;
    players[socket.id].x    = x;
    players[socket.id].y    = y;
    players[socket.id].z    = z;
    players[socket.id].rotY = rotY;
    // Транслируем всем кроме отправителя
    socket.broadcast.emit('playerMoved', { id: socket.id, x, y, z, rotY });
  });

  // ── Выстрел (эффект у всех) ──
  socket.on('playerShoot', ({ x, y, z, dirX, dirY, dirZ }) => {
    socket.broadcast.emit('playerShot', {
      id: socket.id,
      x, y, z, dirX, dirY, dirZ,
    });
  });

  // ── Попадание по игроку ──
  socket.on('hit', ({ targetId, damage }) => {
    const target = players[targetId];
    const shooter = players[socket.id];
    if (!target || !shooter) return;

    target.health -= damage;
    console.log(`[Game] ${shooter.username} → ${target.username}: ${damage} урона (HP: ${target.health})`);

    // Уведомляем жертву об уроне
    io.to(targetId).emit('damaged', { health: target.health, shooterId: socket.id });

    if (target.health <= 0) {
      // ── Kill ──
      shooter.kills++;
      target.deaths++;
      target.health = 100;

      const spawn = randomSpawn();
      target.x = spawn.x;
      target.y = spawn.y;
      target.z = spawn.z;

      const killMsg = `${shooter.username} убил ${target.username}`;
      console.log(`[Kill] ${killMsg}`);

      // Респавним труп
      io.to(targetId).emit('respawn', { x: spawn.x, y: spawn.y, z: spawn.z, health: 100 });

      // Килл-лог для всех
      io.emit('killLog', {
        killer:   shooter.username,
        victim:   target.username,
        message:  killMsg,
        timestamp: Date.now(),
      });

      // Обновлённое здоровье/позиция для всех
      io.emit('playerUpdated', {
        id:     targetId,
        health: 100,
        x:      spawn.x,
        y:      spawn.y,
        z:      spawn.z,
      });
    } else {
      // Просто обновляем здоровье жертвы у всех
      io.emit('playerUpdated', { id: targetId, health: target.health });
    }
  });

  // ── Отключение ──
  socket.on('disconnect', () => {
    if (players[socket.id]) {
      console.log(`[Game] ${players[socket.id].username} покинул игру.`);
      io.emit('playerLeft', { id: socket.id });
      delete players[socket.id];
    }
  });
});

// ──────────────────────────────────────────────
//  Запуск сервера
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🔥 DOOM Multiplayer Server запущен на http://localhost:${PORT}\n`);
  });
});
