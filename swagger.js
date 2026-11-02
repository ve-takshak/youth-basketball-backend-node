// API docs generate karne ki script:  npm run docs   ->  swagger-output.json
// Server isi file se /api-docs par Swagger UI dikhata hai (index.js).
//
// Controllers / routes mein kuch badalne ki zaroorat nahi:
//   1. swagger-autogen routes/api.js padhkar paths, methods, :params aur query fields nikalta hai.
//   2. Neeche ka post-process har route ke liye:
//        - tag     = routes/api.js ka "// ---------- Section ----------" heading
//        - summary = handler ka naam ("listClubs" -> "List clubs")
//        - description = controller ke upar likha /** ... */ comment
//        - requestBody = us comment ki "body: { a, b? }" line (? = optional)
//        - security / access = route ke authentication middleware se
// Naya route ya comment badalne ke baad dobara `npm run docs` chalao.

const fs = require("fs");
const path = require("path");
const swaggerAutogen = require("swagger-autogen")({ openapi: "3.0.0", autoHeaders: false, autoQuery: true, autoBody: true });

const OUTPUT = path.join(__dirname, "swagger-output.json");
const ROUTES_FILE = path.join(__dirname, "routes", "api.js");
const CONTROLLERS_DIR = path.join(__dirname, "app", "controllers");

const doc = {
    info: {
        title: "Courtside – Youth Basketball API",
        description:
            "Admin panel + mobile app API.\n\n" +
            "**Login:** `POST /user/login` sends an OTP, `POST /user/verify-otp` returns a token. " +
            "Click **Authorize** and paste the token (without `Bearer`) to call protected routes.",
        version: "1.0.0",
    },
    servers: [
        { url: "http://localhost:5000/api", description: "Local" },
        { url: "http://51.17.184.245:5000/api", description: "Live" },
    ],
    components: {
        securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
    },
};

const ACCESS = {
    authentication: "Any logged-in user",
    superAdminAuthentication: "Super admin only",
    superAdminOrClubAdminAuthentication: "Super admin or club admin",
};

// ---------- routes/api.js: method, path, middleware, handler, section ----------
const readRoutes = () => {
    const routes = [];
    let section = "";
    fs.readFileSync(ROUTES_FILE, "utf8")
        .split(/\r?\n/)
        .forEach((line) => {
            const heading = line.match(/^\/\/ -{5,}\s*(.+?)\s*-{5,}\s*$/);
            if (heading) {
                section = heading[1].replace(/\s*\(.*\)\s*$/, "").trim();
                return;
            }
            const route = line.match(/^router\.(get|post|put|delete|patch)\(\s*"([^"]+)"\s*,\s*(.+?)\)\s*;\s*(?:\/\/\s*(.*))?$/);
            if (!route) return;
            const parts = route[3].split(",").map((part) => part.trim());
            routes.push({
                method: route[1],
                path: route[2].replace(/:([A-Za-z_]\w*)/g, "{$1}"),
                handler: parts[parts.length - 1],
                middlewares: parts.slice(0, -1),
                tag: section || "General",
                note: route[4] || "",
            });
        });
    return routes;
};

// ---------- controllers: handler ke upar ka /** ... */ comment ----------
const readControllerDocs = () => {
    const docs = {};
    const walk = (dir) => {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) return walk(full);
            if (!entry.name.endsWith(".js")) return;
            const source = fs.readFileSync(full, "utf8");
            const rx = /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*\r?\nconst (\w+)\s*=/g;
            let match;
            while ((match = rx.exec(source))) {
                const text = match[1]
                    .split("\n")
                    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
                    .join("\n")
                    .trim();
                docs[match[2]] = text;
            }
        });
    };
    walk(CONTROLLERS_DIR);
    return docs;
};

// "listClubs" -> "List clubs"
const humanize = (name) => {
    const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
};

// "body: { a, b?, c: {..} }" -> [{ name: "a", required: true }, { name: "b", required: false }, ...]
const parseBodyFields = (comment) => {
    const start = comment.search(/\bbody\s*:\s*\{/i);
    if (start === -1) return [];
    let depth = 0;
    let end = -1;
    for (let i = comment.indexOf("{", start); i < comment.length; i += 1) {
        if (comment[i] === "{") depth += 1;
        if (comment[i] === "}") {
            depth -= 1;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end === -1) return [];

    let inner = comment.slice(comment.indexOf("{", start) + 1, end);
    inner = inner.replace(/\n\s*\*?\s*/g, " "); // multi-line body
    // nested { ... } / ( ... ) / [ ... ] ke andar ka hissa hata do (sirf top-level fields chahiye)
    let previous;
    do {
        previous = inner;
        inner = inner.replace(/\{[^{}]*\}|\([^()]*\)|\[[^\[\]]*\]/g, "");
    } while (inner !== previous);

    return inner
        .split(",")
        .map((piece) => piece.trim().match(/^([A-Za-z_]\w*)(\?)?/))
        .filter(Boolean)
        .map((m) => ({ name: m[1], required: !m[2] }));
};

const buildBodySchema = (fields) => ({
    content: {
        "application/json": {
            schema: {
                type: "object",
                required: fields.filter((f) => f.required).map((f) => f.name),
                properties: Object.fromEntries(fields.map((f) => [f.name, { type: "string" }])),
            },
        },
    },
});

const enrich = (swagger) => {
    const routes = readRoutes();
    const controllerDocs = readControllerDocs();
    const tags = [];
    let documented = 0;

    routes.forEach((route) => {
        const operation = swagger.paths?.[route.path]?.[route.method];
        if (!operation) return;

        if (!tags.includes(route.tag)) tags.push(route.tag);
        operation.tags = [route.tag];
        const namedHandler = /^\w+$/.test(route.handler);
        operation.summary = namedHandler ? humanize(route.handler) : "Health check";

        // Comment ki pehli line "METHOD /api/path?..." hoti hai: woh already path mein hai, isliye hata do
        const comment = (namedHandler && controllerDocs[route.handler]) || "";
        const lines = comment.split("\n");
        if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//i.test(lines[0] || "")) lines.shift();
        const parts = [];
        const access = route.middlewares.map((name) => ACCESS[name]).find(Boolean);
        if (access) parts.push(`**Access:** ${access}`);
        else parts.push("**Access:** Public (no token)");
        if (route.note) parts.push(route.note);
        if (lines.join("\n").trim()) parts.push("```\n" + lines.join("\n").trim() + "\n```");
        operation.description = parts.join("\n\n");

        if (access) {
            operation.security = [{ bearerAuth: [] }];
            operation.responses = { ...operation.responses, 401: { description: "Missing or invalid token" } };
        }

        if (["post", "put", "patch"].includes(route.method)) {
            const fields = parseBodyFields(comment);
            if (fields.length) operation.requestBody = buildBodySchema(fields);
        }
        if (comment) documented += 1;
    });

    swagger.tags = tags.map((name) => ({ name }));
    return { total: routes.length, documented };
};

swaggerAutogen("./swagger-output.json", ["./routes/api.js"], doc).then(() => {
    const swagger = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
    const { total, documented } = enrich(swagger);
    fs.writeFileSync(OUTPUT, JSON.stringify(swagger, null, 2));
    console.log(`API docs: ${total} routes, ${documented} with controller comments -> swagger-output.json`);
});
