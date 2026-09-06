# Examples

Ready-to-try OpenAPI specs for `agentcli server add --openapi`.

## open-meteo-mini.json

A trimmed spec for the [Open-Meteo](https://open-meteo.com) weather API —
free, no auth, so it works out of the box:

```bash
# 1. register (use an absolute path or run from the repo root)
agentcli server add weather --openapi examples/open-meteo-mini.json

# 2. discover — operations grouped by tag
agentcli weather -h

# 3. inspect — flags generated from the spec's JSON Schema
agentcli weather getForecast -h

# 4. execute against the real API
agentcli weather getForecast --latitude 39.9 --longitude 116.4 --current temperature_2m
agentcli weather getForecast --latitude 31.2 --longitude 121.5 --current temperature_2m,wind_speed_10m
```

Pipe-friendly:

```bash
agentcli weather getForecast --latitude 39.9 --longitude 116.4 \
  --current temperature_2m --output text | jq -r '.current.temperature_2m'
```

## Your own API

The same flow works for any OpenAPI 3.x JSON spec (Swagger 2.0 and YAML are
rejected with a conversion hint):

```bash
agentcli server add myapi --openapi ./api.json \
  --base-url https://staging.example.com \
  --header "Authorization: Bearer ${MY_TOKEN}"    # ${ENV} expands at call time
```

Path/query/header parameters and JSON body properties all become flags:

```bash
# POST /pets  { "name": "rex", "kind": "dog" }
agentcli myapi addPet --name rex --kind dog

# complex nested bodies go through --input (flags still override)
agentcli myapi createOrder --input '{"order":{"items":[{"sku":"a","qty":2}]}}'
```