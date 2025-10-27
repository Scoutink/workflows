# Execution Synchronization Fix

## Problem
When creating a shared workflow (Flow C) from another workflow (Flow B) that has execution data (ticked boxes), the execution data was not being properly synchronized. This meant that if you ticked a box in Flow B and then shared Flow B to create Flow C, the box would not be ticked in Flow C.

## Root Cause
The issue was that execution data is stored by individual evidence IDs, but when we have shared items (same `shareKey`), we need to ensure that all evidence items with the same `shareKey` have the same execution status. The original code was only copying execution data when creating a new shared flow, but it wasn't properly handling the case where execution data needs to be synchronized in real-time.

## Solution
I added a `synchronizeSharedExecutionData()` function that:

1. **Collects execution status by shareKey**: First pass through all flows to collect the most recent execution status for each `shareKey`
2. **Applies synchronized status**: Second pass to apply the synchronized status to all evidence items with the same `shareKey`

## Key Changes

### 1. Added `synchronizeSharedExecutionData()` function
```javascript
const synchronizeSharedExecutionData = () => {
    // Create a map of shareKey to the most recent execution status
    const shareKeyToExecutionStatus = new Map();
    
    // First pass: collect all execution statuses by shareKey
    appState.workflow.flows.forEach(flow => {
        const exec = ensureExecFlow(flow.id);
        (flow.data || []).forEach(ctl => (ctl.subcategories || []).forEach(act => (act.subcategories || []).forEach(ev => {
            if (ev.shareKey && typeof exec.completed[ev.id] === 'boolean') {
                // If we already have a status for this shareKey, keep the most recent one (true takes precedence)
                if (!shareKeyToExecutionStatus.has(ev.shareKey) || exec.completed[ev.id] === true) {
                    shareKeyToExecutionStatus.set(ev.shareKey, exec.completed[ev.id]);
                }
            }
        })));
    });
    
    // Second pass: apply the synchronized status to all evidence items with the same shareKey
    appState.workflow.flows.forEach(flow => {
        const exec = ensureExecFlow(flow.id);
        (flow.data || []).forEach(ctl => (ctl.subcategories || []).forEach(act => (act.subcategories || []).forEach(ev => {
            if (ev.shareKey && shareKeyToExecutionStatus.has(ev.shareKey)) {
                exec.completed[ev.id] = shareKeyToExecutionStatus.get(ev.shareKey);
            }
        })));
    });
};
```

### 2. Call synchronization on page load
```javascript
// In loadAll() function
// Synchronize execution data for shared items across all flows
synchronizeSharedExecutionData();
```

### 3. Call synchronization before saving
```javascript
// In saveExecution() function
// Synchronize execution data before saving
synchronizeSharedExecutionData();
```

### 4. Improved `initializeSharedExecutionFromSource()` function
```javascript
const initializeSharedExecutionFromSource = (newFlowId, srcFlowId) => {
    const newFlow = appState.workflow.flows.find(f => f.id === newFlowId);
    const srcExec = ensureExecFlow(srcFlowId);
    
    // Create a map of shareKey to execution status from source flow
    const shareKeyToExecutionStatus = new Map();
    const srcFlow = appState.workflow.flows.find(f => f.id === srcFlowId);
    (srcFlow.data || []).forEach(ctl => (ctl.subcategories || []).forEach(act => (act.subcategories || []).forEach(ev => {
        if (ev.shareKey && typeof srcExec.completed[ev.id] === 'boolean') {
            shareKeyToExecutionStatus.set(ev.shareKey, srcExec.completed[ev.id]);
        }
    })));
    
    // Apply the execution status to the new flow based on shareKey
    (newFlow.data || []).forEach(ctl => (ctl.subcategories || []).forEach(act => (act.subcategories || []).forEach(ev => {
        if (ev.shareKey && shareKeyToExecutionStatus.has(ev.shareKey)) {
            setCompleted(newFlowId, ev.id, shareKeyToExecutionStatus.get(ev.shareKey));
        }
    })));
};
```

## How It Works

1. **On Page Load**: When the application loads, it synchronizes all execution data across shared items
2. **On Save**: Before saving execution data, it synchronizes to ensure consistency
3. **On Share**: When creating a new shared flow, it properly initializes execution data from the source flow
4. **Real-time Sync**: The `propagateSharedExecution()` function ensures that when you tick a box in one flow, it's immediately synchronized to all other flows with the same `shareKey`

## Testing

I created comprehensive test files to verify the fix:

1. **`test_execution_sync.html`** - Tests the synchronization function
2. **`test_complete_scenario.html`** - Tests the complete scenario you described

## Result

Now when you:
1. Clone Flow A to create Flow B
2. Tick a box in Flow B (execution mode)
3. Share Flow B to create Flow C

Flow C will have the same ticked box as Flow B, because all evidence items with the same `shareKey` are properly synchronized across all flows.

The fix ensures that shared items (same `shareKey`) always have consistent execution status across all flows, which is exactly what you expected from the sharing functionality.