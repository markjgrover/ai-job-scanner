<?php
// ============================================================
//  Job Status API — /jobs/status_api.php
//  GET  → returns all statuses (public, no auth)
//  POST → updates a status (requires X-Auth-Token header)
//
//  Password is read from config.json in the parent directory.
//  Never hardcode passwords in this file.
// ============================================================

// Load password from config.json
$configFile = __DIR__ . '/../config.json';
$ownerPassword = 'changeme'; // fallback only
if (file_exists($configFile)) {
    $cfg = json_decode(file_get_contents($configFile), true);
    if (!empty($cfg['ownerPassword'])) {
        $ownerPassword = $cfg['ownerPassword'];
    }
}

define('OWNER_PASSWORD', $ownerPassword);
define('STATUS_FILE',    __DIR__ . '/job_status.json');
define('ALLOWED',        ['new','applied','phone_screen','interview','offer','rejected','not_interested']);

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Auth-Token');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

// ── READ (no auth) ──────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo file_exists(STATUS_FILE) ? file_get_contents(STATUS_FILE) : '{}';
    exit;
}

// ── WRITE (auth required) ───────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $token = $_SERVER['HTTP_X_AUTH_TOKEN'] ?? '';
    if ($token !== OWNER_PASSWORD) {
        http_response_code(401);
        echo json_encode(['error' => 'Unauthorized']);
        exit;
    }

    $body = json_decode(file_get_contents('php://input'), true);
    if (!$body || empty($body['jobId']) || empty($body['status'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Missing jobId or status']);
        exit;
    }

    if (!in_array($body['status'], ALLOWED)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid status']);
        exit;
    }

    $statuses = file_exists(STATUS_FILE)
        ? (json_decode(file_get_contents(STATUS_FILE), true) ?? [])
        : [];

    $existing = $statuses[$body['jobId']] ?? [];
    $statuses[$body['jobId']] = [
        'status'    => $body['status'],
        'updatedAt' => date('c'),
        'appliedAt' => ($body['status'] === 'applied' && empty($existing['appliedAt']))
                       ? date('c')
                       : ($existing['appliedAt'] ?? null),
        'notes'     => $body['notes'] ?? ($existing['notes'] ?? ''),
    ];

    file_put_contents(STATUS_FILE, json_encode($statuses, JSON_PRETTY_PRINT));
    echo json_encode(['ok' => true, 'jobId' => $body['jobId'], 'status' => $body['status']]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
