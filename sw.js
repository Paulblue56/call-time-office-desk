"use strict";

const CACHE_NAME = "call-time-app-shell-v8";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js?v=8",
  "./manifest.webmanifest",
  "./assets/call-time-logo.png",
  "./assets/workspace-background.png",
  "./app-icon-192.png",
  "./app-icon-512.png",
  "./app-icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.startsWith("call-time-app-shell-") && name !== CACHE_NAME)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);
  if (request.method !== "GET" || requestUrl.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(request)) || caches.match("./index.html");
      }
    })());
    return;
  }

  const isAppShellAsset = APP_SHELL.some((path) => new URL(path, self.registration.scope).href === requestUrl.href);
  if (!isAppShellAsset) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  })());
});
