// Antes de todo: cargar env como ya lo haces
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);

// ORIGIN permitido (usa la variable de entorno si existe)
const CLIENT_ORIGIN = process.env.NEXT_PUBLIC_CLIENT_ORIGIN || "http://localhost:3000";

// Cors options explícitas
const corsOptions = {
  origin: (origin, callback) => {
    // origin puede ser undefined para herramientas como curl; permitimos en ese caso
    if (!origin || origin === CLIENT_ORIGIN || origin.includes("localhost")) {
      callback(null, true);
    } else {
      callback(new Error("CORS: Origin no permitido: " + origin));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true, // poner true si necesitas enviar cookies/credenciales
};

// Usar CORS con opciones (maneja preflight)
app.use(cors(corsOptions));
//app.options("*", cors(corsOptions)); // responder OPTIONS globalmente (importante para socket.io polling)

// Middlewares normales
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Crear instancia de socket.io con la misma configuración CORS
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const PORT = process.env.PORT || 3001
const HOST = process.env.HOST || "0.0.0.0";
const SEGMENTS_FILE = path.join(__dirname, "data", "segments.json")
const EVENTS_LOG = path.join(__dirname, "data", "events.log")

// Crear directorio data si no existe
if (!fs.existsSync(path.join(__dirname, "data"))) {
  fs.mkdirSync(path.join(__dirname, "data"))
}

// Cargar o crear segmentos por defecto
function loadSegments() {
  if (!fs.existsSync(SEGMENTS_FILE)) {
    const defaultSegments = [
      { id: "SKU_A", text: "Premio A", color: "#eae56f" },
      { id: "SKU_B", text: "Premio B", color: "#89f26e" },
      { id: "SKU_C", text: "Premio C", color: "#7de6ef" },
      { id: "SKU_D", text: "Premio D", color: "#e7706f" },
      { id: "SKU_E", text: "Premio E", color: "#a17cf3" },
      { id: "SKU_F", text: "Premio F", color: "#f49e4c" },
    ]
    fs.writeFileSync(SEGMENTS_FILE, JSON.stringify(defaultSegments, null, 2))
    return defaultSegments
  }
  return JSON.parse(fs.readFileSync(SEGMENTS_FILE, "utf-8"))
}

function saveSegments(segments) {
  fs.writeFileSync(SEGMENTS_FILE, JSON.stringify(segments, null, 2))
}

let segments = loadSegments()

// Endpoint para obtener segmentos
app.get("/api/segments", (req, res) => {
  res.json({ segments })
})

// Endpoint para actualizar segmentos (admin)
app.post("/api/segments", (req, res) => {
  try {
    const { segments: newSegments } = req.body

    if (!Array.isArray(newSegments) || newSegments.length === 0) {
      return res.status(400).json({ error: "Invalid segments data" })
    }

    // Validar estructura de segmentos
    for (const seg of newSegments) {
      if (!seg.id || !seg.text || !seg.color) {
        return res.status(400).json({ error: "Each segment must have id, text, and color" })
      }
    }

    segments = newSegments
    saveSegments(segments)

    // Notificar a todos los clientes conectados
    io.emit("segments-updated", segments)

    res.json({ success: true, segments })
  } catch (err) {
    console.error("Error updating segments:", err)
    res.status(500).json({ error: "Failed to update segments" })
  }
})

// Webhook endpoint para Tikfinity/IFTTT
app.post("/webhook/tikfinity", (req, res) => {
  try {
    console.log("📥 Webhook recibido:", req.body)

    // Validar token secreto si está configurado
    if (process.env.TIKFINITY_SECRET) {
      const incomingToken = req.headers["x-tikfinity-token"] || req.body.secret
      if (!incomingToken || incomingToken !== process.env.TIKFINITY_SECRET) {
        console.warn("⚠️ Token inválido")
        return res.status(401).json({ error: "Invalid token" })
      }
    }

    // Extraer parámetros de Tikfinity/IFTTT
    const username = req.body.value1 || req.body.username || "Anónimo"
    const text = req.body.value2 || req.body.text || ""
    const sku = req.body.value3 || req.body.sku || null

    console.log(`👤 Usuario: ${username}, SKU: ${sku}`)

    // Buscar segmento por SKU
    let segmentIndex = -1
    if (sku) {
      segmentIndex = segments.findIndex((s) => String(s.id).toUpperCase() === String(sku).toUpperCase())
    }

    // Si no se encuentra el SKU, elegir uno aleatorio
    if (segmentIndex === -1) {
      segmentIndex = Math.floor(Math.random() * segments.length)
      console.log(`🎲 SKU no encontrado, seleccionando aleatorio: índice ${segmentIndex}`)
    } else {
      console.log(`🎯 SKU encontrado: índice ${segmentIndex}`)
    }

    const event = {
      type: "spin",
      username,
      text,
      sku,
      segmentIndex,
      segment: segments[segmentIndex],
      timestamp: new Date().toISOString(),
    }

    // Emitir evento a todos los clientes conectados
    io.emit("spin", event)
    console.log("✅ Evento emitido a clientes:", event)

    // Guardar en log
    fs.appendFile(EVENTS_LOG, JSON.stringify(event) + "\n", (err) => {
      if (err) console.error("Error writing log:", err)
    })

    res.json({
      success: true,
      event,
      message: "Spin event emitted successfully",
    })
  } catch (err) {
    console.error("❌ Error en webhook:", err)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Endpoint de prueba para simular webhook localmente
app.post("/api/test-spin", (req, res) => {
  const { sku } = req.body

  let segmentIndex = -1
  if (sku) {
    segmentIndex = segments.findIndex((s) => String(s.id).toUpperCase() === String(sku).toUpperCase())
  }

  if (segmentIndex === -1) {
    segmentIndex = Math.floor(Math.random() * segments.length)
  }

  const event = {
    type: "spin",
    username: "Test User",
    text: "Test spin",
    sku: sku || null,
    segmentIndex,
    segment: segments[segmentIndex],
    timestamp: new Date().toISOString(),
  }

  io.emit("spin", event)

  res.json({ success: true, event })
})

// Socket.io
io.on("connection", (socket) => {
  console.log("🔌 Cliente conectado:", socket.id)

  // Enviar segmentos actuales al conectar
  socket.emit("segments-updated", segments)

  socket.on("disconnect", () => {
    console.log("🔌 Cliente desconectado:", socket.id)
  })
})

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", segments: segments.length })
})


// Listen con host 0.0.0.0 y log de URL pública si existe
server.listen(PORT, HOST, () => {
  console.log(`🚀 Servidor corriendo en ${HOST}:${PORT}`);
  console.log(`📊 Segmentos cargados: ${segments.length}`);

  // Detectar URL pública
  const publicUrlCandidates = [
    process.env.RAILWAY_STATIC_URL,
    process.env.RAILWAY_STATIC_URLS,
    process.env.RAILWAY_PUBLIC_URL,
    process.env.PUBLIC_URL,
    process.env.APP_URL,
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
    process.env.RENDER_EXTERNAL_URL,
  ].filter(Boolean);

  if (publicUrlCandidates.length > 0) {
    console.log("🌐 Detected public URL(s):", publicUrlCandidates.join(", "));
    console.log(`🎯 Webhook URL sugerida: ${publicUrlCandidates[0].replace(/\/$/, "")}/webhook/tikfinity`);
  } else {
    console.log("ℹ️ No se detectó URL pública en variables de entorno.");
    console.log("👉 Revisa 'Open app' o 'Deployments' en Railway para la URL pública.");
    console.log(`(Mientras tanto el webhook local es: http://localhost:${PORT}/webhook/tikfinity)`);
  }
});
