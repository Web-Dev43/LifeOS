self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  const title = payload.title || "LifeOS";
  const options = {
    body: payload.body || "You’ve got something worth doing.",
    tag: payload.tag || "lifeos",
    data: { url: payload.url || "/" },
    icon: "/",
    badge: "/"
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      const open = clients.find(client => new URL(client.url).pathname === new URL(url, self.location.origin).pathname);
      return open ? open.focus() : self.clients.openWindow(url);
    })
  );
});
