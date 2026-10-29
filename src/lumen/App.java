package lumen;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

import static java.nio.charset.StandardCharsets.UTF_8;

/** HTTP layer: JSON API under /api, uploaded photos under /images, and the web client for everything else. */
public final class App implements HttpHandler {
    private static final int MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    private static final int MAX_FORM_BYTES = 16 * 1024;
    private static final Pattern IMAGE_NAME = Pattern.compile("[A-Za-z0-9_-]+\\.(jpg|png|webp)");
    private static final Map<String, String> CONTENT_TYPES = Map.of(
            "html", "text/html; charset=utf-8",
            "css", "text/css; charset=utf-8",
            "js", "text/javascript; charset=utf-8",
            "svg", "image/svg+xml",
            "jpg", "image/jpeg",
            "png", "image/png",
            "webp", "image/webp");

    private final Store store;
    private final Path imageDir;
    private final Path webDir;

    private App(Path dataDir, Path webDir) throws IOException {
        Files.createDirectories(dataDir);
        this.imageDir = Files.createDirectories(dataDir.resolve("images"));
        this.store = Store.load(dataDir.resolve("store.bin"));
        this.webDir = webDir.toAbsolutePath().normalize();
    }

    public static void start(int port, Path dataDir, Path webDir) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/", new App(dataDir, webDir));
        server.setExecutor(Executors.newFixedThreadPool(16));
        server.start();
    }

    @Override
    public void handle(HttpExchange ex) throws IOException {
        try {
            String path = ex.getRequestURI().getPath();
            if (path.startsWith("/api/")) api(ex, path.substring("/api/".length()).split("/"));
            else if (path.startsWith("/images/")) serveImage(ex, path.substring("/images/".length()));
            else serveStatic(ex, path);
        } catch (HttpError e) {
            sendError(ex, e.status, e.getMessage());
        } catch (IllegalArgumentException e) {
            sendError(ex, 400, "Bad request");
        } catch (Exception e) {
            e.printStackTrace();
            sendError(ex, 500, "Something went wrong on our side");
        } finally {
            ex.close();
        }
    }

    private void api(HttpExchange ex, String[] p) throws IOException {
        String m = ex.getRequestMethod();
        String token = bearerToken(ex);
        Object result;

        if (route(m, p, "POST", "signup")) {
            Map<String, String> form = form(ex);
            result = session(store.signup(form.getOrDefault("username", ""), form.getOrDefault("password", "")));
        } else if (route(m, p, "POST", "login")) {
            Map<String, String> form = form(ex);
            result = session(store.login(form.getOrDefault("username", ""), form.getOrDefault("password", "")));
        } else {
            String me = store.userFor(token);
            if (me == null) throw new HttpError(401, "Please log in");

            if (route(m, p, "POST", "logout")) {
                store.logout(token);
                result = Json.obj("ok", true);
            } else if (route(m, p, "GET", "me")) {
                result = store.me(me);
            } else if (route(m, p, "POST", "me")) {
                result = store.setBio(me, form(ex).getOrDefault("bio", ""));
            } else if (route(m, p, "GET", "feed")) {
                String before = query(ex).get("before");
                result = store.feed(me, before == null ? Long.MAX_VALUE : Long.parseLong(before));
            } else if (route(m, p, "GET", "explore")) {
                result = store.explore(me);
            } else if (route(m, p, "GET", "suggestions")) {
                result = store.suggestions(me);
            } else if (route(m, p, "GET", "users")) {
                result = store.search(query(ex).getOrDefault("q", ""), me);
            } else if (route(m, p, "GET", "users", "*")) {
                result = store.profile(p[1], me);
            } else if (route(m, p, "POST", "users", "*", "follow")) {
                result = store.follow(p[1], me, true);
            } else if (route(m, p, "DELETE", "users", "*", "follow")) {
                result = store.follow(p[1], me, false);
            } else if (route(m, p, "POST", "posts")) {
                result = createPost(ex, me);
            } else if (route(m, p, "GET", "posts", "*")) {
                result = store.post(Long.parseLong(p[1]), me);
            } else if (route(m, p, "DELETE", "posts", "*")) {
                Files.deleteIfExists(imageDir.resolve(store.deletePost(Long.parseLong(p[1]), me)));
                result = Json.obj("ok", true);
            } else if (route(m, p, "POST", "posts", "*", "like")) {
                result = store.like(Long.parseLong(p[1]), me, true);
            } else if (route(m, p, "DELETE", "posts", "*", "like")) {
                result = store.like(Long.parseLong(p[1]), me, false);
            } else if (route(m, p, "POST", "posts", "*", "comments")) {
                result = store.comment(Long.parseLong(p[1]), me, form(ex).getOrDefault("text", ""));
            } else {
                throw new HttpError(404, "Not found");
            }
        }
        send(ex, 200, "application/json; charset=utf-8", Json.of(result).getBytes(UTF_8));
    }

    private Map<String, Object> session(String token) {
        return Json.obj("token", token, "user", store.me(store.userFor(token)));
    }

    /** Photo bytes arrive as the raw request body; the caption rides in the query string. */
    private Object createPost(HttpExchange ex, String me) throws IOException {
        byte[] image = readBody(ex, MAX_IMAGE_BYTES);
        String ext = sniffImageType(image);
        if (ext == null) throw new HttpError(415, "Please upload a JPEG, PNG or WebP image");
        String name = Store.randomToken(12) + "." + ext;
        Path file = imageDir.resolve(name);
        Files.write(file, image);
        try {
            return store.createPost(me, name, query(ex).getOrDefault("caption", ""));
        } catch (RuntimeException e) {
            Files.deleteIfExists(file);
            throw e;
        }
    }

    private static String sniffImageType(byte[] b) {
        if (b.length > 3 && (b[0] & 0xff) == 0xFF && (b[1] & 0xff) == 0xD8 && (b[2] & 0xff) == 0xFF) return "jpg";
        if (b.length > 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "png";
        if (b.length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "webp";
        return null;
    }

    private void serveImage(HttpExchange ex, String name) throws IOException {
        if (!IMAGE_NAME.matcher(name).matches()) throw new HttpError(404, "Not found");
        Path file = imageDir.resolve(name);
        if (!Files.isRegularFile(file)) throw new HttpError(404, "Not found");
        ex.getResponseHeaders().set("Cache-Control", "public, max-age=31536000, immutable");
        send(ex, 200, CONTENT_TYPES.get(extension(name)), Files.readAllBytes(file));
    }

    private void serveStatic(HttpExchange ex, String path) throws IOException {
        if (!ex.getRequestMethod().equals("GET")) throw new HttpError(405, "Method not allowed");
        Path file = webDir.resolve(path.equals("/") ? "index.html" : path.substring(1)).normalize();
        String type = CONTENT_TYPES.get(extension(file.toString()));
        if (!file.startsWith(webDir) || type == null || !Files.isRegularFile(file)) throw new HttpError(404, "Not found");
        ex.getResponseHeaders().set("Cache-Control", "no-cache");
        send(ex, 200, type, Files.readAllBytes(file));
    }

    // ---- request/response helpers ----

    private static boolean route(String method, String[] path, String wantMethod, String... pattern) {
        if (!method.equals(wantMethod) || path.length != pattern.length) return false;
        for (int i = 0; i < pattern.length; i++) {
            if (!pattern[i].equals("*") && !pattern[i].equals(path[i])) return false;
        }
        return true;
    }

    private static String bearerToken(HttpExchange ex) {
        String header = ex.getRequestHeaders().getFirst("Authorization");
        return header != null && header.startsWith("Bearer ") ? header.substring(7).trim() : null;
    }

    private static Map<String, String> form(HttpExchange ex) throws IOException {
        return parseUrlEncoded(new String(readBody(ex, MAX_FORM_BYTES), UTF_8));
    }

    private static Map<String, String> query(HttpExchange ex) {
        return parseUrlEncoded(ex.getRequestURI().getRawQuery());
    }

    private static Map<String, String> parseUrlEncoded(String raw) {
        Map<String, String> out = new HashMap<>();
        if (raw == null || raw.isEmpty()) return out;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            String key = eq < 0 ? pair : pair.substring(0, eq);
            String value = eq < 0 ? "" : pair.substring(eq + 1);
            out.put(URLDecoder.decode(key, UTF_8), URLDecoder.decode(value, UTF_8));
        }
        return out;
    }

    private static byte[] readBody(HttpExchange ex, int max) throws IOException {
        byte[] body = ex.getRequestBody().readNBytes(max + 1);
        if (body.length > max) throw new HttpError(413, "That's too big to upload");
        return body;
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase();
    }

    private static void sendError(HttpExchange ex, int status, String message) {
        if (ex.getResponseCode() != -1) return; // headers already sent; nothing useful left to do
        try {
            send(ex, status, "application/json; charset=utf-8", Json.of(Json.obj("error", message)).getBytes(UTF_8));
        } catch (IOException ignored) {
            // client went away
        }
    }

    private static void send(HttpExchange ex, int status, String type, byte[] body) throws IOException {
        Headers headers = ex.getResponseHeaders();
        headers.set("Content-Type", type);
        headers.set("X-Content-Type-Options", "nosniff");
        ex.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
        if (body.length > 0) ex.getResponseBody().write(body);
    }
}
