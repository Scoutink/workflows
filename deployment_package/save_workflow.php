<?php
header('Content-Type: application/json');

$filename = 'workflow.json';
$json_data = file_get_contents('php://input');

if (empty($json_data)) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'No data received.']);
    exit;
}

$data = json_decode($json_data);
if (json_last_error() !== JSON_ERROR_NONE) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'Invalid JSON format.']);
    exit;
}

/*
 Schema (v6):
 {
   "settings": {...},
   "flows": [
      {"id":"flow-...","name":"...","data":[ ... controls/actions/evidence ... ]}
   ]
 }
*/
$pretty_json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);

if (file_put_contents($filename, $pretty_json) !== false) {
    echo json_encode(['status' => 'success', 'message' => 'Workflow saved successfully.']);
} else {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'Failed to save workflow. Check file permissions on the server.']);
}
?>
