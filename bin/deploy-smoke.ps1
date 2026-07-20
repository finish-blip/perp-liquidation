$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

docker compose up --build --detach mysql redis api stream-consumer worker

$deadline = (Get-Date).AddMinutes(3)
do {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:3010/healthz" -TimeoutSec 3
    if ($health.status -eq "ok") {
      break
    }
  } catch {
    Start-Sleep -Seconds 2
  }
} while ((Get-Date) -lt $deadline)

if ((Get-Date) -ge $deadline) {
  docker compose ps
  docker compose logs --tail 100 api mysql redis stream-consumer
  throw "Deployment did not become healthy within three minutes"
}

$market = $env:BINANCE_SMOKE_MARKET
if ([string]::IsNullOrWhiteSpace($market)) {
  $market = "BTCUSDT"
}

$snapshot = Invoke-RestMethod `
  -Uri "http://127.0.0.1:3010/v1/markets/$market/snapshot" `
  -TimeoutSec 30

docker compose --profile smoke run --rm binance-smoke
docker compose ps
$snapshot | ConvertTo-Json -Depth 5
