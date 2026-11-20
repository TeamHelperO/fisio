const P = new URLSearchParams(location.search);
window.FISIO_BACKEND.handle('POST', '/api/login', { email: (P.get('as') || 'admin') + '@demo.fisio', password: 'demo1234' });
await import('./js/app.js');
const route = P.get('route');
if (route) setTimeout(async () => (await import('./js/state.js')).go('#/' + route), 400);
