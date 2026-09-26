# Internal-only resolver (ADR-010, SEC-27): answers Compose service names by
# forwarding to Docker's embedded DNS and returns NXDOMAIN for every other
# name, so DNS cannot carry data out of the internal network.
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
RUN apk add --no-cache dnsmasq
COPY docker/dns/dnsmasq.conf /etc/dnsmasq.conf
CMD ["dnsmasq", "--keep-in-foreground", "--log-facility=-"]
