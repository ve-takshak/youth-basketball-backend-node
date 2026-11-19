require("dotenv").config(); // sabse upar, taaki database.js ko MONGODB_URI mil jaye

const express = require("express");
const cors = require("cors");
const path = require("path");
const fileUpload = require("express-fileupload");
const router = require("./routes/api.js");
const signS3Urls = require("./app/middleware/signS3Urls");

const app = express();

// Purane local logos ke liye (jo S3 se pehle upload hue the)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Kaun se frontend is API ko call kar sakte hain
const allowedOrigins = [
    "http://13.63.166.225", "http://51.17.184.245"
];

// Local development: koi bhi localhost port (3000, 3001...)
const localhostPattern = /^http:\/\/localhost:[0-9]+$/;

app.use(cors({
    origin: (origin, callback) => {
        // Postman / server-to-server calls mein origin nahi hota, unhe allow karo
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || localhostPattern.test(origin)) {
            return callback(null, true);
        }
        console.warn(`CORS blocked: ${origin}`);
        return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Disposition"], // web panel download (Form 101 PDF) ko file ka naam mile
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "1mb" })); // Terms (rich text) 100kb se bade ho sakte hain

// form-data (files + text fields) padhne ke liye: req.files aur req.body yahi bharta hai
app.use(fileUpload({
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    abortOnLimit: true,
}));

app.get("/", (req, res) => res.send("Hello from Node.js!"));

// API docs (Swagger UI): http://localhost:5000/api-docs
// swagger-output.json `npm run docs` se banta hai (routes / controller comments badalne ke baad dobara chalao)
try {
    const swaggerUi = require("swagger-ui-express");
    const swaggerDocument = require("./swagger-output.json");
    app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
        customSiteTitle: "Courtside API docs",
        swaggerOptions: { persistAuthorization: true, docExpansion: "none", tagsSorter: "alpha" },
    }));
} catch (e) {
    console.warn("API docs not available (run `npm run docs`):", e.message);
}

// Bucket private: response ke S3 photo / logo URL signed bankar jaate hain
app.use("/api", signS3Urls, router);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Badi upload (Form 101: ID + documents ~20MB, phir PDF + email) slow mobile network pe bhi beech mein na kate
server.requestTimeout = 5 * 60 * 1000; // poori request (body upload + response) max 5 minute
server.headersTimeout = 2 * 60 * 1000; // headers aane ka time
server.keepAliveTimeout = 65 * 1000; // load balancer / nginx ke 60s se zyada, taaki connection beech mein band na ho