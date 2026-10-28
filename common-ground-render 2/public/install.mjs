const guide = document.getElementById('install-guide');
const installButton = document.getElementById('install-now');
const installStatus = document.getElementById('install-status');
const connectionStatus = document.getElementById('connection-status');
let installPrompt;

function updateConnection() {
  const online = navigator.onLine !== false;
  connectionStatus.dataset.online = String(online);
  connectionStatus.textContent = online
    ? 'Shared pilot · Sign-in, profiles, and chat require internet.'
    : 'You’re offline. Connect to sign in, load profiles, or send messages.';
}

window.CommonGroundInstall = {
  show() {
    if (!guide.open) guide.showModal();
    updateConnection();
  },
};

document.getElementById('close-install').addEventListener('click', () => guide.close());
guide.addEventListener('click', event => { if (event.target === guide) guide.close(); });
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  installButton.hidden = true;
  installStatus.textContent = 'Common Ground is installed. Sign in to connect with your network.';
});
installButton.addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  installButton.hidden = true;
  try { await prompt.prompt(); }
  catch { installStatus.textContent = 'Use your browser menu to add Common Ground to your Home Screen.'; }
});
for (const event of ['online', 'offline']) window.addEventListener(event, updateConnection);
updateConnection();

if (window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
    installStatus.textContent = 'Use your browser’s installation menu. Keep an internet connection to use the shared pilot.';
  });
}
