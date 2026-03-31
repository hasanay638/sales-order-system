const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendFile(filePath, response) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Dosya bulunamadi.");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream"
    });
    response.end(data);
  });
}

function resolveRequestPath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const normalized = path.normalize(requested).replace(/^(\.\.[\\/])+/, "");
  return path.join(FRONTEND_DIR, normalized);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const filePath = resolveRequestPath(url.pathname);

  if (!filePath.startsWith(FRONTEND_DIR)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Erisim engellendi.");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isFile()) {
      sendFile(filePath, response);
      return;
    }

    const fallbackPath = path.join(FRONTEND_DIR, "index.html");
    sendFile(fallbackPath, response);
  });
});

server.listen(PORT, () => {
  console.log(`Portal hazir: http://localhost:${PORT}`);
});
