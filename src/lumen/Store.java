package lumen;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * All application state. Every public operation is synchronized and persists the
 * whole store to disk after a mutation, which is plenty for a single-node app.
 */
final class Store implements Serializable {
    private static final long serialVersionUID = 1L;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern USERNAME = Pattern.compile("[a-z0-9_.]{3,20}");
    private static final int PAGE_SIZE = 20;
    private static final int EXPLORE_SIZE = 60;

    static final class User implements Serializable {
        private static final long serialVersionUID = 1L;
        final String name;
        final byte[] salt;
        final byte[] hash;
        final long joined = System.currentTimeMillis();
        final Set<String> followers = new TreeSet<>();
        final Set<String> following = new TreeSet<>();
        String bio = "";

        User(String name, byte[] salt, byte[] hash) {
            this.name = name;
            this.salt = salt;
            this.hash = hash;
        }
    }

    static final class Comment implements Serializable {
        private static final long serialVersionUID = 1L;
        final String author;
        final String text;
        final long at = System.currentTimeMillis();

        Comment(String author, String text) {
            this.author = author;
            this.text = text;
        }
    }

    static final class Post implements Serializable {
        private static final long serialVersionUID = 1L;
        final long id;
        final String author;
        final String image;
        final String caption;
        final long at = System.currentTimeMillis();
        final Set<String> likes = new LinkedHashSet<>();
        final List<Comment> comments = new ArrayList<>();

        Post(long id, String author, String image, String caption) {
            this.id = id;
            this.author = author;
            this.image = image;
            this.caption = caption;
        }
    }

    private final Map<String, User> users = new HashMap<>();
    private final TreeMap<Long, Post> posts = new TreeMap<>();
    private final Map<String, String> sessions = new HashMap<>();
    private long nextPostId = 1;
    private transient Path file;

    static Store load(Path file) throws IOException {
        Store store;
        if (Files.exists(file)) {
            try (var in = new ObjectInputStream(new BufferedInputStream(Files.newInputStream(file)))) {
                store = (Store) in.readObject();
            } catch (ClassNotFoundException e) {
                throw new IOException("Corrupt store file " + file, e);
            }
        } else {
            store = new Store();
        }
        store.file = file;
        return store;
    }

    // ---- accounts & sessions ----

    String signup(String rawName, String password) {
        String name = normalize(rawName);
        if (!USERNAME.matcher(name).matches()) {
            throw new HttpError(400, "Username must be 3-20 characters: letters, numbers, _ or .");
        }
        if (password.length() < 8) throw new HttpError(400, "Password must be at least 8 characters");
        byte[] salt = randomBytes(16);
        byte[] hash = hash(password, salt); // slow on purpose, so done outside the lock
        synchronized (this) {
            if (users.containsKey(name)) throw new HttpError(409, "That username is taken");
            users.put(name, new User(name, salt, hash));
            return openSession(name);
        }
    }

    String login(String rawName, String password) {
        String name = normalize(rawName);
        User user;
        synchronized (this) {
            user = users.get(name);
        }
        // Hash even for unknown users so response time doesn't reveal which names exist.
        byte[] candidate = hash(password, user == null ? new byte[16] : user.salt);
        if (user == null || !MessageDigest.isEqual(candidate, user.hash)) {
            throw new HttpError(401, "Wrong username or password");
        }
        synchronized (this) {
            return openSession(name);
        }
    }

    synchronized void logout(String token) {
        if (token != null && sessions.remove(token) != null) save();
    }

    synchronized String userFor(String token) {
        return token == null ? null : sessions.get(token);
    }

    synchronized Map<String, Object> me(String viewer) {
        return userJson(requireUser(viewer), viewer);
    }

    synchronized Map<String, Object> setBio(String viewer, String bio) {
        String clean = bio.strip();
        if (clean.length() > 150) throw new HttpError(400, "Bio can be at most 150 characters");
        User user = requireUser(viewer);
        user.bio = clean;
        save();
        return userJson(user, viewer);
    }

    // ---- people ----

    synchronized Map<String, Object> profile(String name, String viewer) {
        User user = requireUser(name);
        Map<String, Object> json = userJson(user, viewer);
        json.put("photos", posts.descendingMap().values().stream()
                .filter(p -> p.author.equals(name))
                .map(p -> postJson(p, viewer))
                .collect(Collectors.toList()));
        return json;
    }

    synchronized Map<String, Object> follow(String target, String viewer, boolean on) {
        if (target.equals(viewer)) throw new HttpError(400, "You can't follow yourself");
        User them = requireUser(target);
        User me = requireUser(viewer);
        if (on) {
            me.following.add(target);
            them.followers.add(viewer);
        } else {
            me.following.remove(target);
            them.followers.remove(viewer);
        }
        save();
        return userJson(them, viewer);
    }

    synchronized List<Map<String, Object>> search(String query, String viewer) {
        String q = normalize(query);
        if (q.isEmpty()) return List.of();
        return users.values().stream()
                .filter(u -> u.name.contains(q))
                .sorted(Comparator.comparing((User u) -> !u.name.startsWith(q))
                        .thenComparing(u -> -u.followers.size())
                        .thenComparing(u -> u.name))
                .limit(20)
                .map(u -> userJson(u, viewer))
                .collect(Collectors.toList());
    }

    /** Popular accounts the viewer doesn't follow yet. */
    synchronized List<Map<String, Object>> suggestions(String viewer) {
        User me = requireUser(viewer);
        return users.values().stream()
                .filter(u -> !u.name.equals(viewer) && !me.following.contains(u.name))
                .sorted(Comparator.comparing((User u) -> -u.followers.size()).thenComparing(u -> -u.joined))
                .limit(8)
                .map(u -> userJson(u, viewer))
                .collect(Collectors.toList());
    }

    // ---- posts ----

    /** Posts by the viewer and the people they follow, newest first, older than {@code before}. */
    synchronized List<Map<String, Object>> feed(String viewer, long before) {
        User me = requireUser(viewer);
        List<Map<String, Object>> page = new ArrayList<>();
        for (Post p : posts.headMap(before, false).descendingMap().values()) {
            if (p.author.equals(viewer) || me.following.contains(p.author)) {
                page.add(postJson(p, viewer));
                if (page.size() == PAGE_SIZE) break;
            }
        }
        return page;
    }

    /** Everyone's posts ranked by engagement with time decay ("hot" ranking). */
    synchronized List<Map<String, Object>> explore(String viewer) {
        long now = System.currentTimeMillis();
        return posts.values().stream()
                .sorted(Comparator.comparingDouble((Post p) -> -hotness(p, now)))
                .limit(EXPLORE_SIZE)
                .map(p -> postJson(p, viewer))
                .collect(Collectors.toList());
    }

    synchronized Map<String, Object> post(long id, String viewer) {
        return postJson(requirePost(id), viewer);
    }

    synchronized Map<String, Object> createPost(String author, String image, String caption) {
        String clean = caption.strip();
        if (clean.length() > 2200) throw new HttpError(400, "Caption can be at most 2200 characters");
        requireUser(author);
        Post post = new Post(nextPostId++, author, image, clean);
        posts.put(post.id, post);
        save();
        return postJson(post, author);
    }

    /** Deletes the viewer's own post and returns its image file name so the caller can remove it. */
    synchronized String deletePost(long id, String viewer) {
        Post post = requirePost(id);
        if (!post.author.equals(viewer)) throw new HttpError(403, "You can only delete your own posts");
        posts.remove(id);
        save();
        return post.image;
    }

    synchronized Map<String, Object> like(long id, String viewer, boolean on) {
        Post post = requirePost(id);
        boolean changed = on ? post.likes.add(viewer) : post.likes.remove(viewer);
        if (changed) save();
        return postJson(post, viewer);
    }

    synchronized Map<String, Object> comment(long id, String viewer, String text) {
        String clean = text.strip();
        if (clean.isEmpty()) throw new HttpError(400, "Comment can't be empty");
        if (clean.length() > 500) throw new HttpError(400, "Comment can be at most 500 characters");
        Post post = requirePost(id);
        post.comments.add(new Comment(viewer, clean));
        save();
        return postJson(post, viewer);
    }

    // ---- helpers ----

    static String randomToken(int bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(randomBytes(bytes));
    }

    private String openSession(String name) {
        String token = randomToken(32);
        sessions.put(token, name);
        save();
        return token;
    }

    private User requireUser(String name) {
        User user = name == null ? null : users.get(name);
        if (user == null) throw new HttpError(404, "No such user");
        return user;
    }

    private Post requirePost(long id) {
        Post post = posts.get(id);
        if (post == null) throw new HttpError(404, "That post doesn't exist");
        return post;
    }

    private Map<String, Object> userJson(User u, String viewer) {
        long postCount = posts.values().stream().filter(p -> p.author.equals(u.name)).count();
        return Json.obj(
                "name", u.name,
                "bio", u.bio,
                "joined", u.joined,
                "posts", postCount,
                "followers", u.followers.size(),
                "following", u.following.size(),
                "followedByMe", viewer != null && u.followers.contains(viewer));
    }

    private Map<String, Object> postJson(Post p, String viewer) {
        return Json.obj(
                "id", p.id,
                "author", p.author,
                "image", "/images/" + p.image,
                "caption", p.caption,
                "at", p.at,
                "likes", p.likes.size(),
                "liked", viewer != null && p.likes.contains(viewer),
                "comments", p.comments.stream()
                        .map(c -> Json.obj("author", c.author, "text", c.text, "at", c.at))
                        .collect(Collectors.toList()));
    }

    private static double hotness(Post p, long now) {
        double hours = (now - p.at) / 3_600_000.0;
        return (1 + p.likes.size() + 2.0 * p.comments.size()) / Math.pow(hours + 2, 1.5);
    }

    private static String normalize(String name) {
        return name == null ? "" : name.strip().toLowerCase(Locale.ROOT);
    }

    private static byte[] randomBytes(int n) {
        byte[] bytes = new byte[n];
        RANDOM.nextBytes(bytes);
        return bytes;
    }

    private static byte[] hash(String password, byte[] salt) {
        try {
            var spec = new PBEKeySpec(password.toCharArray(), salt, 120_000, 256);
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private void save() {
        try {
            Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            try (var out = new ObjectOutputStream(new BufferedOutputStream(Files.newOutputStream(tmp)))) {
                out.writeObject(this);
            }
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
