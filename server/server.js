require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');


const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.NEXT_PUBLIC_CLIENT_URL,
        methods: ["GET", "POST"]
    }
});

// Lưu trữ trạng thái game
const rooms = {};
const resetLimits = {};


// Tạo bàn cờ mới
const createInitialBoard = (size) => {
    return Array(size).fill(null).map(() => Array(size).fill(null));
};

app.get('/rooms', (req, res) => {
    const roomList = Object.keys(rooms).map(roomId => {
        return {
            roomId,
            playerX: rooms[roomId].players.X ? true : false,
            playerO: rooms[roomId].players.O ? true : false,
            currentPlayer: rooms[roomId].currentPlayer,
            board: rooms[roomId].board
        };
    });
    res.json(roomList);
});

io.on('connection', (socket) => {
    console.log(`Người dùng kết nối: ${socket.id}`);

    // Tham gia phòng
    socket.on('join-room', (roomId, callback) => {
        if (!rooms[roomId]) {
            rooms[roomId] = {
                board: createInitialBoard(20),
                currentPlayer: 'X',
                players: { X: null, O: null }
            };
        }

        const room = rooms[roomId];

        if (room.players.X && room.players.O) {
            callback({ success: false, message: 'Phòng đã đầy' });
            return;
        }

        if (!room.players.X) {
            room.players.X = socket.id;
            socket.role = 'X';
        } else if (!room.players.O) {
            room.players.O = socket.id;
            socket.role = 'O';
        }

        socket.join(roomId);
        callback({
            success: true,
            role: socket.role,
            board: room.board,
            currentPlayer: room.currentPlayer
        });

        // Thông báo cho người chơi khác
        socket.to(roomId).emit('player-joined', socket.id);

        io.to(roomId).emit('room-update', {
            players: room.players,
            board: room.board,
            currentPlayer: room.currentPlayer
        });
    });

    // Xử lý nước đi
    socket.on('make-move', ({ row, col, roomId }) => {
        const room = rooms[roomId];
        if (!room || room.currentPlayer !== socket.role) return;

        // Thêm check đủ players
        if (!room.players.X || !room.players.O) {
            socket.emit('move-failed', 'Chờ đủ 2 người chơi để bắt đầu!');
            return;
        }

        if (room.board[row][col]) return;

        room.board[row][col] = socket.role;
        room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';

        io.to(roomId).emit('move-made', {
            row, col, player: socket.role, currentPlayer: room.currentPlayer
        });
    });

    // Xử lý chat
    socket.on('send-message', (message, roomId) => {
        const sender = socket.role === 'X' ? 'Người chơi X' : 'Người chơi O';
        const chatMessage = {
            sender,
            text: message,
            timestamp: new Date()
        };

        io.to(roomId).emit('chat-message', chatMessage);
    });


    // Thay thế toàn bộ phần reset-game bằng đoạn code này
    socket.on('reset-game', (roomId) => {
        if (!rooms[roomId]) {
            socket.emit('reset-failed', 'Phòng không tồn tại');
            return;
        }

        // Kiểm tra xem người gửi có trong phòng không
        const playerInRoom = rooms[roomId].players.X === socket.id ||
            rooms[roomId].players.O === socket.id;

        if (!playerInRoom) {
            socket.emit('reset-failed', 'Bạn không có trong phòng này');
            return;
        }

        // Thiết lập hệ thống giới hạn reset
        if (!resetLimits[roomId]) {
            resetLimits[roomId] = { count: 0, lastReset: Date.now() };
        }

        const now = Date.now();
        const timeDiff = now - resetLimits[roomId].lastReset;

        // Reset bộ đếm nếu quá 1 phút
        if (timeDiff > 60000) {
            resetLimits[roomId] = { count: 1, lastReset: now };
        } else {
            // Kiểm tra giới hạn
            if (resetLimits[roomId].count >= 3) {
                socket.emit('reset-failed', 'Bạn chỉ được reset 3 lần mỗi phút');
                return;
            }
            resetLimits[roomId].count++;
        }

        // Reset trạng thái game
        rooms[roomId].board = createInitialBoard(20);
        rooms[roomId].currentPlayer = 'X';
        rooms[roomId].history = [];

        // Gửi thông báo reset
        io.to(roomId).emit('game-reset', {
            board: rooms[roomId].board,
            currentPlayer: rooms[roomId].currentPlayer
        });
    });

    // Chơi lại
    socket.on('reset-game', (roomId) => {
        if (!rooms[roomId]) return;

        if (!resetLimits[roomId]) {
            resetLimits[roomId] = { count: 0, lastReset: Date.now() };
        }

        // Reset count nếu quá 1 phút (sửa từ phản hồi trước để tránh block vĩnh viễn)
        if (Date.now() - resetLimits[roomId].lastReset >= 60000) {
            resetLimits[roomId].count = 0;
            resetLimits[roomId].lastReset = Date.now();
        }

        if (resetLimits[roomId].count >= 3) {
            socket.emit('reset-failed', 'Bạn đã reset quá nhiều lần trong phút này');
            return;
        }

        // Tăng count
        resetLimits[roomId].count++;

        // Reset game, giữ players
        rooms[roomId] = {
            ...rooms[roomId],
            board: createInitialBoard(20),
            currentPlayer: 'X'
        };

        io.to(roomId).emit('game-reset', {
            board: rooms[roomId].board,
            currentPlayer: rooms[roomId].currentPlayer,
            players: rooms[roomId].players
        });
    });

    // Đầu hàng
    socket.on('surrender', (roomId) => {
        const winner = socket.role === 'X' ? 'O' : 'X';
        io.to(roomId).emit('game-over', winner);
    });

    // Yêu cầu hòa
    socket.on('request-draw', (roomId) => {
        socket.to(roomId).emit('draw-request');
    });

    // Phản hồi hòa
    socket.on('respond-draw', (accepted, roomId) => {
        socket.to(roomId).emit('draw-response', accepted);
        if (accepted) {
            io.to(roomId).emit('game-over', 'DRAW');
        }
    });

    // Ngắt kết nối
    socket.on('disconnect', () => {
        Object.keys(rooms).forEach(roomId => {
            if (rooms[roomId].players.X === socket.id) {
                rooms[roomId].players.X = null;
            } else if (rooms[roomId].players.O === socket.id) {
                rooms[roomId].players.O = null;
            }
            // Thêm
            io.to(roomId).emit('room-update', { players: rooms[roomId].players });
            io.to(roomId).emit('player-left', socket.id);
        });
    });
});

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`Socket.IO server đang chạy trên cổng ${PORT}`);
});