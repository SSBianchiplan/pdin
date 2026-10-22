param(
  [int]$Port = 18380,
  [switch]$Local,        # ignora Docker/PostgreSQL e serve apenas os arquivos estáticos (modo local no navegador)
  [switch]$SemNavegador
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Write-Host "GPlanSiS|PDIN - Planejamento Digital da Industria (modo operacional)" -ForegroundColor Cyan

if ($Local) {
  Write-Host "Modo local: http://127.0.0.1:$Port (sem API; persistencia no navegador)" -ForegroundColor Yellow
  if (-not $SemNavegador) { Start-Process "http://127.0.0.1:$Port" }
  python -m http.server $Port --bind 127.0.0.1
  return
}

# 1) Banco PostgreSQL demo (127.0.0.1:5437, banco pdin_demo). Senha padrao apenas para uso local.
if (-not $env:PDIN_DB_PASSWORD) { $env:PDIN_DB_PASSWORD = 'pdin_demo_local' }
docker compose up -d | Out-Host
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  docker exec pdin-db pg_isready -U pdin_owner -d pdin_demo *> $null
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ok) { throw 'PostgreSQL nao ficou disponivel. Verifique o Docker Desktop.' }
Write-Host 'PostgreSQL pronto em 127.0.0.1:5437 (pdin_demo).' -ForegroundColor Green

# 2) API + frontend
if (-not $env:PDIN_DATABASE_URL) { $env:PDIN_DATABASE_URL = "postgresql://pdin_owner:$($env:PDIN_DB_PASSWORD)@127.0.0.1:5437/pdin_demo" }
python -c "import fastapi, uvicorn, psycopg" 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host 'Instalando dependencias da API...' -ForegroundColor Yellow; python -m pip install -r api/requirements.txt | Out-Host }
Write-Host "Aplicacao: http://127.0.0.1:$Port   (documentacao da API: /api/docs). Ctrl+C encerra." -ForegroundColor Green
if (-not $SemNavegador) { Start-Process "http://127.0.0.1:$Port" }
python -m uvicorn api.main:app --host 127.0.0.1 --port $Port
