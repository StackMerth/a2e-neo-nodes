# E6 / M3.8c: TokenOS Docker Image Registry container.
#
# We wrap Docker's official open-source registry binary
# (distribution/distribution) without modification. The registry runs
# as-is from the upstream image; all customization happens via the
# config file and env vars baked / mounted at runtime:
#
#   - /etc/docker/registry/config.yml       (this image, default policy)
#   - /etc/docker/registry/cert.pem         (Render Secret File, RS256 verify cert)
#   - REGISTRY_* env vars                   (Render dashboard, override any config key)
#
# The registry's env-var override pattern means almost nothing has to
# live inside the image itself. Default config.yml provides the bare
# minimum (storage filesystem fallback, log level, health check) so
# this image runs in plain Docker for local testing without any env.
# Production values come from Render env vars.
#
# Why pin to 2.8.3: as of 2026-06, that's the latest patch release of
# the stable 2.x line. 3.x is in active development with breaking
# changes to the auth subsystem we depend on (token issuer URL +
# RS256 verification). Pin major+minor here; review before upgrading.

FROM registry:2.8.3

# Wipe the upstream config so our defaults are unambiguous and any
# config the upstream layer ships does not leak into ours.
RUN rm -f /etc/docker/registry/config.yml

COPY config.yml /etc/docker/registry/config.yml

# Registry serves on 5000 by default. Render auto-detects this from
# the EXPOSE directive when binding the public web port.
EXPOSE 5000

# No CMD override — upstream image already launches /entrypoint.sh
# which reads config.yml + env overrides and runs the registry binary.
