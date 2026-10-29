import lumen.App;

import java.nio.file.Path;

public class Main {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
        App.start(port, Path.of("data"), Path.of("web"));
        System.out.println("Lumen is running at http://localhost:" + port);
    }
}
