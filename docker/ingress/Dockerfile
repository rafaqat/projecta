# Port-publishing sidecar. Application containers live only on the internal
# network (INV-02); this is the single container that also sits on the
# host-facing bridge, forwarding published ports inward with socat.
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
RUN apk add --no-cache socat
COPY docker/ingress/forward.sh /forward.sh
RUN chmod +x /forward.sh
CMD ["/forward.sh"]
