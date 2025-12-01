const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const runScraper = require('./scraper');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = 3000;

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve CSV files from the root directory
app.use('/download', express.static(__dirname));

io.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('start-scrape', async (data) => {
        const { query } = data;
        console.log(`Received start-scrape request for: ${query}`);

        try {
            const filename = await runScraper(query, socket);
            console.log(`Scrape completed. File: ${filename}`);
        } catch (error) {
            console.error('Scrape failed:', error);
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

server.listen(PORT, () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
    console.log(`📊 Open your browser and navigate to the URL above\n`);
});
