FROM eclipse-temurin:17-jdk AS build
WORKDIR /build
COPY src ./src
RUN mkdir out && javac -d out $(find src -name '*.java')

FROM eclipse-temurin:17-jre
WORKDIR /app
RUN useradd --system --no-create-home lumen \
    && mkdir data \
    && chown lumen:lumen data
COPY --from=build /build/out ./classes
COPY web ./web
USER lumen
ENV PORT=8080
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["java", "-cp", "classes", "Main"]
