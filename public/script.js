const socket = io();

const queryInput = document.getElementById('queryInput');
const startBtn = document.getElementById('startBtn');
const statusText = document.getElementById('statusText');
const progressText = document.getElementById('progressText');
const resultsBody = document.getElementById('resultsBody');
const logsContainer = document.getElementById('logsContainer');
const downloadLink = document.getElementById('downloadLink');

startBtn.addEventListener('click', () => {
    const query = queryInput.value.trim();
    if (!query) return alert('Please enter a search query');

    // Reset UI
    resultsBody.innerHTML = '';
    logsContainer.innerHTML = '';
    downloadLink.classList.add('hidden');
    startBtn.disabled = true;
    statusText.textContent = 'Scraping...';
    progressText.textContent = '0/10 Verified';

    // Start scrape
    socket.emit('start-scrape', { query });
});

socket.on('log', (message) => {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.textContent = `> ${message}`;
    logsContainer.appendChild(div);
    logsContainer.scrollTop = logsContainer.scrollHeight;
});

socket.on('new-result', (data) => {
    const tr = document.createElement('tr');

    let statusClass = '';
    if (data.status === 'Official Website') statusClass = 'status-official';
    else if (data.status === 'No Website') statusClass = 'status-none';
    else if (data.status === 'Platform Only') statusClass = 'status-platform';
    else if (data.status === 'Found via Search') statusClass = 'status-search';

    tr.innerHTML = `
        <td>${data.name}</td>
        <td>${data.address}</td>
        <td>${data.phone}</td>
        <td><a href="${data.website}" target="_blank">${data.website || '-'}</a></td>
        <td>${data.email || '-'}</td>
        <td class="${statusClass}">${data.status}</td>
    `;
    resultsBody.appendChild(tr);
});

socket.on('progress', (data) => {
    progressText.textContent = `${data.verified}/${data.target} Verified`;
});

socket.on('scrape-complete', (data) => {
    statusText.textContent = 'Completed!';
    startBtn.disabled = false;

    if (data.filename) {
        downloadLink.href = `/download/${data.filename}`;
        downloadLink.classList.remove('hidden');
        downloadLink.textContent = `Download ${data.filename}`;
    }
});

socket.on('error', (data) => {
    statusText.textContent = 'Error occurred';
    startBtn.disabled = false;
    alert(`Error: ${data.message}`);
});
