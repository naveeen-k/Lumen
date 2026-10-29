package lumen;

/** An error that maps directly to an HTTP status and a user-facing message. */
final class HttpError extends RuntimeException {
    final int status;

    HttpError(int status, String message) {
        super(message);
        this.status = status;
    }
}
