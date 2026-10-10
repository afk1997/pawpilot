# The backup service of docker/docker-compose.yml: the database's own image for its Postgres 17 client tools
# (pg_dump, pg_restore), curl for the Azure Blob upload, and scripts/backup.sh as the entrypoint.
FROM postgres:17-alpine
RUN apk add --no-cache curl
COPY --chmod=755 scripts/backup.sh /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["schedule"]
