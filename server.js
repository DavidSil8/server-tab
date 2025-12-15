const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const port = 8008;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory data structures
const users = new Map(); // nickname -> {password, stats}
const games = new Map(); // gameId -> {players, state, board, currentTurn, etc}
const rankings = new Map(); // boardSize -> [{nickname, wins, games}]
const sseClients = new Map(); // gameId -> [response objects]

let gameIdCounter = 1;

// Helper functions
function generateGameId() {
  return `game-${gameIdCounter++}`;
}

function sendSSEToGame(gameId, data) {
  const clients = sseClients.get(gameId);
  if (clients) {
    clients.forEach(client => {
      try {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (error) {
        console.error('Error sending SSE message:', error);
      }
    });
  }
}

function validateUser(nickname, password) {
  if (!nickname || !password) {
    return { valid: false, message: 'Nickname and password are required' };
  }
  if (typeof nickname !== 'string' || typeof password !== 'string') {
    return { valid: false, message: 'Invalid data types' };
  }
  return { valid: true };
}

function authenticateUser(nickname, password) {
  const user = users.get(nickname);
  if (!user) {
    // Create new user
    users.set(nickname, { password, wins: 0, games: 0 });
    return { authenticated: true, isNew: true };
  }
  if (user.password !== password) {
    return { authenticated: false, message: 'Invalid password' };
  }
  return { authenticated: true, isNew: false };
}

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Routes

// POST /register - Authenticate users
app.post('/register', (req, res) => {
  try {
    const { nickname, password } = req.body;
    
    const validation = validateUser(nickname, password);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.message });
    }

    const auth = authenticateUser(nickname, password);
    if (!auth.authenticated) {
      return res.status(401).json({ error: auth.message });
    }

    res.json({ 
      success: true, 
      message: auth.isNew ? 'User registered successfully' : 'User authenticated',
      nickname 
    });
  } catch (error) {
    console.error('Error in /register:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /join - Join or create a game
app.post('/join', (req, res) => {
  try {
    const { nickname, gameId, boardSize = 10 } = req.body;

    if (!nickname) {
      return res.status(400).json({ error: 'Nickname is required' });
    }

    if (!users.has(nickname)) {
      return res.status(401).json({ error: 'User not registered' });
    }

    let game;
    let newGameId;

    if (gameId && games.has(gameId)) {
      // Join existing game
      game = games.get(gameId);
      if (game.players.some(p => p.nickname === nickname)) {
        return res.status(400).json({ error: 'Already in this game' });
      }
      if (game.players.length >= 4) {
        return res.status(400).json({ error: 'Game is full' });
      }
      game.players.push({ nickname, position: 0, score: 0 });
      newGameId = gameId;
    } else {
      // Create new game
      newGameId = generateGameId();
      game = {
        gameId: newGameId,
        boardSize: parseInt(boardSize) || 10,
        players: [{ nickname, position: 0, score: 0 }],
        currentTurn: 0,
        status: 'waiting',
        started: false
      };
      games.set(newGameId, game);
      sseClients.set(newGameId, []);
    }

    // Notify all players in the game
    sendSSEToGame(newGameId, {
      type: 'player-joined',
      nickname,
      players: game.players,
      gameId: newGameId
    });

    res.json({ 
      success: true, 
      gameId: newGameId,
      boardSize: game.boardSize,
      players: game.players 
    });
  } catch (error) {
    console.error('Error in /join:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /roll - Handle dice rolling
app.post('/roll', (req, res) => {
  try {
    const { nickname, gameId } = req.body;

    if (!nickname || !gameId) {
      return res.status(400).json({ error: 'Nickname and gameId are required' });
    }

    const game = games.get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const playerIndex = game.players.findIndex(p => p.nickname === nickname);
    if (playerIndex === -1) {
      return res.status(403).json({ error: 'Not in this game' });
    }

    if (game.currentTurn !== playerIndex) {
      return res.status(400).json({ error: 'Not your turn' });
    }

    // Roll dice (1-6)
    const diceRoll = Math.floor(Math.random() * 6) + 1;
    const player = game.players[playerIndex];
    player.position += diceRoll;
    
    // Check win condition
    if (player.position >= game.boardSize) {
      player.position = game.boardSize;
      game.status = 'finished';
      
      // Update user stats
      const user = users.get(nickname);
      if (user) {
        user.wins++;
        user.games++;
      }
      
      // Update rankings
      const rankingKey = game.boardSize.toString();
      if (!rankings.has(rankingKey)) {
        rankings.set(rankingKey, []);
      }
      const ranking = rankings.get(rankingKey);
      const existingRank = ranking.find(r => r.nickname === nickname);
      if (existingRank) {
        existingRank.wins++;
        existingRank.games++;
      } else {
        ranking.push({ nickname, wins: 1, games: 1 });
      }
    }

    // Notify all players
    sendSSEToGame(gameId, {
      type: 'roll',
      nickname,
      diceRoll,
      position: player.position,
      status: game.status
    });

    res.json({ 
      success: true, 
      diceRoll,
      position: player.position,
      status: game.status
    });
  } catch (error) {
    console.error('Error in /roll:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /notify - Process move notifications
app.post('/notify', (req, res) => {
  try {
    const { nickname, gameId, message, type } = req.body;

    if (!gameId) {
      return res.status(400).json({ error: 'GameId is required' });
    }

    const game = games.get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    // Broadcast notification to all players
    sendSSEToGame(gameId, {
      type: type || 'notification',
      nickname,
      message,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error in /notify:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /pass - Pass turn to next player
app.post('/pass', (req, res) => {
  try {
    const { nickname, gameId } = req.body;

    if (!nickname || !gameId) {
      return res.status(400).json({ error: 'Nickname and gameId are required' });
    }

    const game = games.get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const playerIndex = game.players.findIndex(p => p.nickname === nickname);
    if (playerIndex === -1) {
      return res.status(403).json({ error: 'Not in this game' });
    }

    if (game.currentTurn !== playerIndex) {
      return res.status(400).json({ error: 'Not your turn' });
    }

    // Move to next player
    game.currentTurn = (game.currentTurn + 1) % game.players.length;
    const nextPlayer = game.players[game.currentTurn];

    // Notify all players
    sendSSEToGame(gameId, {
      type: 'turn-passed',
      previousPlayer: nickname,
      currentPlayer: nextPlayer.nickname,
      currentTurn: game.currentTurn
    });

    res.json({ 
      success: true, 
      currentPlayer: nextPlayer.nickname,
      currentTurn: game.currentTurn
    });
  } catch (error) {
    console.error('Error in /pass:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ranking - Get rankings for a board size
app.post('/ranking', (req, res) => {
  try {
    const { boardSize = 10 } = req.body;
    
    const rankingKey = boardSize.toString();
    let ranking = rankings.get(rankingKey) || [];
    
    // Sort by wins descending, then by games played ascending
    ranking = ranking.sort((a, b) => {
      if (b.wins !== a.wins) {
        return b.wins - a.wins;
      }
      return a.games - b.games;
    });

    res.json({ 
      success: true, 
      boardSize,
      rankings: ranking.slice(0, 10) // Top 10
    });
  } catch (error) {
    console.error('Error in /ranking:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /update - SSE connection for live updates
app.get('/update', (req, res) => {
  try {
    const { gameId } = req.query;

    if (!gameId) {
      return res.status(400).json({ error: 'GameId is required' });
    }

    const game = games.get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Add client to the game's SSE clients
    if (!sseClients.has(gameId)) {
      sseClients.set(gameId, []);
    }
    sseClients.get(gameId).push(res);

    // Send initial connection message
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      gameId,
      players: game.players,
      currentTurn: game.currentTurn,
      status: game.status
    })}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      const clients = sseClients.get(gameId);
      if (clients) {
        const index = clients.indexOf(res);
        if (index !== -1) {
          clients.splice(index, 1);
        }
      }
    });
  } catch (error) {
    console.error('Error in /update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /leave - Handle player leaving/resigning
app.post('/leave', (req, res) => {
  try {
    const { nickname, gameId } = req.body;

    if (!nickname || !gameId) {
      return res.status(400).json({ error: 'Nickname and gameId are required' });
    }

    const game = games.get(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const playerIndex = game.players.findIndex(p => p.nickname === nickname);
    if (playerIndex === -1) {
      return res.status(403).json({ error: 'Not in this game' });
    }

    // Remove player from game
    game.players.splice(playerIndex, 1);
    const remainingPlayers = game.players.length;

    // Adjust current turn if necessary
    if (playerIndex < game.currentTurn) {
      // Player left before current turn, decrement to maintain order
      game.currentTurn--;
    } else if (game.currentTurn >= game.players.length && game.players.length > 0) {
      // Current turn is out of bounds, wrap to start
      game.currentTurn = 0;
    }

    // If no players left, clean up the game
    if (remainingPlayers === 0) {
      games.delete(gameId);
      sseClients.delete(gameId);
    } else {
      // Notify remaining players
      sendSSEToGame(gameId, {
        type: 'player-left',
        nickname,
        players: game.players,
        currentTurn: game.currentTurn
      });
    }

    res.json({ 
      success: true, 
      message: 'Left game successfully',
      remainingPlayers: remainingPlayers
    });
  } catch (error) {
    console.error('Error in /leave:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(port, () => {
  console.log(`TAB Board Game Server running on port ${port}`);
  console.log(`Server started at ${new Date().toISOString()}`);
});