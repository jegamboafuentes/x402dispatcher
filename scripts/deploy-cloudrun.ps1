# Deploy x402dispatcher to Cloud Run (GCP project experiment-jegf-personal)
param(
  [string]$ProjectId = "experiment-jegf-personal",
  [string]$Region = "us-central1",
  [string]$Service = "x402dispatcher",
  [string]$Repo = "x402dispatcher",
  [ValidateSet("development", "production")]
  [string]$X402Env = "production"
)

$ErrorActionPreference = "Stop"

function Test-GcloudResource {
  param([string[]]$GcloudArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & gcloud @GcloudArgs 2>$null | Out-Null
  $ok = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $prev
  return $ok
}

Write-Host "Project=$ProjectId Region=$Region Service=$Service X402_ENV=$X402Env"

gcloud config set project $ProjectId

Write-Host "Enabling required APIs..."
gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  secretmanager.googleapis.com `
  --project $ProjectId

$registry = "$Region-docker.pkg.dev/$ProjectId/$Repo"
Write-Host "Ensuring Artifact Registry repo..."
if (-not (Test-GcloudResource @("artifacts", "repositories", "describe", $Repo, "--location=$Region", "--project=$ProjectId"))) {
  gcloud artifacts repositories create $Repo `
    --repository-format=docker `
    --location=$Region `
    --description="x402dispatcher images" `
    --project=$ProjectId
}

$image = "$registry/x402dispatcher:latest"
Write-Host "Building $image ..."
gcloud builds submit --tag $image --project $ProjectId

$secretNames = @(
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
  "MAX_PRICE_USD"
)

Write-Host "Checking Secret Manager secrets..."
foreach ($name in $secretNames) {
  if (-not (Test-GcloudResource @("secrets", "describe", $name, "--project=$ProjectId"))) {
    Write-Host "Creating secret $name (value from local .env if present)..."
    $value = $null
    if (Test-Path ".env") {
      $line = Get-Content ".env" | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -First 1
      if ($line) {
        $value = ($line -split "=", 2)[1].Trim().Trim('"').Trim("'")
      }
    }
    if (-not $value) {
      throw "Missing secret $name. Add it to .env or create it in Secret Manager, then re-run."
    }
    # Write UTF-8 without BOM/newline — PowerShell piping can corrupt base64 secrets.
    $tmpFile = Join-Path $env:TEMP "x402dispatcher-$name.secret"
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllBytes($tmpFile, $utf8.GetBytes($value))
    try {
      gcloud secrets create $name --data-file=$tmpFile --project=$ProjectId
    } finally {
      Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue
    }
  } else {
    Write-Host "Secret $name already exists"
  }
}

$projectNumber = (gcloud projects describe $ProjectId --format="value(projectNumber)")
$runtimeSa = "$projectNumber-compute@developer.gserviceaccount.com"
Write-Host "Granting secretAccessor to $runtimeSa ..."
foreach ($name in $secretNames) {
  gcloud secrets add-iam-policy-binding $name `
    --member="serviceAccount:$runtimeSa" `
    --role="roles/secretmanager.secretAccessor" `
    --project=$ProjectId | Out-Null
}

Write-Host "Deploying Cloud Run service..."
gcloud run deploy $Service `
  --image $image `
  --region $Region `
  --platform managed `
  --allow-unauthenticated `
  --port 8080 `
  --memory 1Gi `
  --cpu 1 `
  --timeout 300 `
  --max-instances 3 `
  --set-secrets "CDP_API_KEY_ID=CDP_API_KEY_ID:latest,CDP_API_KEY_SECRET=CDP_API_KEY_SECRET:latest,CDP_WALLET_SECRET=CDP_WALLET_SECRET:latest,MAX_PRICE_USD=MAX_PRICE_USD:latest" `
  --set-env-vars "HOST=0.0.0.0,DATA_DIR=/tmp/x402dispatcher-data,MARKUP_BPS=1000,DISCOVERY_LIMIT=40,VERIFIED_MIN_SAMPLES=2,VERIFIED_MIN_SUCCESS_RATE=0.8,X402_ENV=$X402Env" `
  --project $ProjectId

$url = gcloud run services describe $Service --region $Region --project $ProjectId --format="value(status.url)"
Write-Host "Setting PUBLIC_BASE_URL=$url ..."
gcloud run services update $Service `
  --region $Region `
  --project $ProjectId `
  --update-env-vars "PUBLIC_BASE_URL=$url" | Out-Null
Write-Host ""
Write-Host "Deployed: $url"
Write-Host "Health:   $url/health"
Write-Host "Agent:    $url/.well-known/agent.json"
Write-Host "MCP:      $url/mcp"
Write-Host ""
Write-Host "Smoke test:"
Write-Host "  `$env:PUBLIC_BASE_URL='$url'; npm run test:v5"
