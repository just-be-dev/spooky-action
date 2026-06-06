import index from "./index.html";

const server = Bun.serve({
  port: 7777,
  routes: {
    "/": index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Pinch detector running at ${server.url}`);
