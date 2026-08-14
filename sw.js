self.addEventListener('push', (event) => {
  let data = { title: '프레임 체커', body: '새 알림이 도착했습니다.' };
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    try {
      data = { title: '프레임 체커', body: event.data.text() };
    } catch {}
  }

  const title = data.title || '프레임 체커';
  const options = { body: data.body || '' };

  event.waitUntil(
    self.registration.showNotification(title, options).catch((err) => {
      console.error('showNotification failed', err);
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
