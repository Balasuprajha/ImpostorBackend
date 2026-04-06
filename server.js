const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: [
      'https://impostor-rosy.vercel.app',
      'http://localhost:3000',
      'http://localhost:3001',
    ],
    methods: ['GET', 'POST'],
    credentials: true,
    allowEIO3: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.use(cors());
app.use(express.json());

// Game state storage
const games = {}; // gameId -> gameState

// Helper function to generate game ID
const generateGameId = () => Math.random().toString(36).substring(2, 9);

// Helper function to get random impostor index
const getRandomImpostorIndex = (numPlayers) => Math.floor(Math.random() * numPlayers);

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'Server running' });
});

// Socket.io events
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create a new game
  socket.on('createGame', (data, callback) => {
    const gameId = generateGameId();
    const { numPlayers, wordPair, playerName } = data;
    const impostorIndex = getRandomImpostorIndex(numPlayers);

    games[gameId] = {
      id: gameId,
      host: socket.id,
      numPlayers,
      wordPair,
      impostorIndex,
      players: {
        [socket.id]: {
          name: playerName,
          index: 0,
          description: null,
          vote: null,
        },
      },
      gamePhase: 'waiting', // waiting, filling, revealing, voting, results
      descriptions: {},
      votes: {},
    };

    socket.join(gameId);
    socket.gameId = gameId;

    console.log(`Game ${gameId} created by ${playerName}`);
    callback({ gameId, player: games[gameId].players[socket.id] });
  });

  // Join an existing game
  socket.on('joinGame', (data, callback) => {
    const { gameId, playerName } = data;
    const game = games[gameId];

    if (!game) {
      callback({ success: false, error: 'Game not found' });
      return;
    }

    const playerIndex = Object.keys(game.players).length;

    if (playerIndex >= game.numPlayers) {
      callback({ success: false, error: 'Game is full' });
      return;
    }

    game.players[socket.id] = {
      name: playerName,
      index: playerIndex,
      description: null,
      vote: null,
    };

    socket.join(gameId);
    socket.gameId = gameId;

    io.to(gameId).emit('playerJoined', {
      playerName,
      playerCount: Object.keys(game.players).length,
      totalPlayers: game.numPlayers,
    });

    console.log(`${playerName} joined game ${gameId}`);
    callback({ success: true, player: game.players[socket.id] });
  });

  // Get game state
  socket.on('getGameState', (callback) => {
    const gameId = socket.gameId;
    if (games[gameId]) {
      const game = games[gameId];
      const isHost = game.host === socket.id;
      const isImpostor = game.players[socket.id]?.index === game.impostorIndex;

      callback({
        gameId,
        gamePhase: game.gamePhase,
        numPlayers: game.numPlayers,
        playerCount: Object.keys(game.players).length,
        currentPlayer: game.players[socket.id],
        isHost,
        isImpostor,
        wordPair: game.wordPair,
        descriptions: game.descriptions,
        votes: game.votes,
        players: Object.values(game.players).map(p => ({
          name: p.name,
          index: p.index,
        })),
      });
    }
  });

  // Start game
  socket.on('startGame', () => {
    const game = games[socket.gameId];
    if (game && game.host === socket.id) {
      game.gamePhase = 'filling';
      io.to(socket.gameId).emit('gameStarted', {
        wordPair: game.wordPair,
        impostorIndex: game.impostorIndex,
        players: Object.values(game.players).map(p => p.name),
      });
    }
  });

  // Submit description
  socket.on('submitDescription', (description) => {
    const game = games[socket.gameId];
    if (game) {
      const playerName = game.players[socket.id].name;
      game.descriptions[playerName] = description;

      // Check if all players submitted
      if (Object.keys(game.descriptions).length === game.numPlayers) {
        game.gamePhase = 'revealing';
        io.to(socket.gameId).emit('allDescriptionsSubmitted', {
          descriptions: game.descriptions,
        });
      } else {
        io.to(socket.gameId).emit('descriptionReceived', {
          playerName,
          description,
        });
      }
    }
  });

  // Host reveals descriptions
  socket.on('revealDescriptions', () => {
    const game = games[socket.gameId];
    if (game && game.host === socket.id) {
      game.gamePhase = 'voting';
      io.to(socket.gameId).emit('descriptionsRevealed', {
        descriptions: game.descriptions,
      });
    }
  });

  // Submit vote
  socket.on('submitVote', (votedPlayerName) => {
    const game = games[socket.gameId];
    if (game) {
      const voter = game.players[socket.id].name;
      game.votes[voter] = votedPlayerName;

      // Check if all votes submitted
      if (Object.keys(game.votes).length === game.numPlayers) {
        game.gamePhase = 'results';

        // Determine winner
        const voteCount = {};
        Object.values(game.votes).forEach(voted => {
          voteCount[voted] = (voteCount[voted] || 0) + 1;
        });

        const mostVoted = Object.keys(voteCount).reduce((a, b) =>
          voteCount[a] > voteCount[b] ? a : b
        );

        const impostorName = Object.values(game.players).find(
          p => p.index === game.impostorIndex
        ).name;

        const teamWon = mostVoted === impostorName;

        io.to(socket.gameId).emit('gameResults', {
          impostorName,
          mostVoted,
          teamWon,
          votes: game.votes,
          voteCount,
          wordPair: game.wordPair,
          descriptions: game.descriptions,
        });
      } else {
        io.to(socket.gameId).emit('voteReceived', {
          voter,
        });
      }
    }
  });

  // Restart game
  socket.on('restartGame', () => {
    const game = games[socket.gameId];
    if (game && game.host === socket.id) {
      game.gamePhase = 'waiting';
      game.descriptions = {};
      game.votes = {};
      game.impostorIndex = getRandomImpostorIndex(game.numPlayers);
      io.to(socket.gameId).emit('gameRestarted');
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const gameId = socket.gameId;
    if (gameId && games[gameId]) {
      const game = games[gameId];

      // If host disconnects, delete game
      if (game.host === socket.id) {
        io.to(gameId).emit('hostDisconnected');
        delete games[gameId];
        console.log(`Game ${gameId} deleted (host disconnected)`);
      } else {
        // Remove player from game
        delete game.players[socket.id];
        io.to(gameId).emit('playerLeft', {
          playerCount: Object.keys(game.players).length,
          totalPlayers: game.numPlayers,
        });

        // Delete game if empty
        if (Object.keys(game.players).length === 0) {
          delete games[gameId];
        }
      }
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎭 Word Impostor Server running on port ${PORT}`);
});

module.exports = app;
