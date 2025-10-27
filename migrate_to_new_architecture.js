/**
 * Migration Script: Convert Old Architecture to New Reference-Based Architecture
 * 
 * This script converts the existing hierarchical data structure to the new
 * reference-based architecture while preserving all data and relationships.
 */

// Migration function
function migrateToNewArchitecture(oldData) {
    console.log('Starting migration to new reference-based architecture...');
    
    const newState = {
        items: {},
        flows: {},
        itemHierarchy: {},
        executions: {},
        currentFlowId: oldData.workflow.flows[0]?.id || null,
        currentMode: 'execution',
        selectedActionPaths: {},
        expandedTextAreas: new Set(),
        activeTag: null,
        theme: 'light'
    };
    
    // Step 1: Migrate flows
    console.log('Migrating flows...');
    oldData.workflow.flows.forEach(flow => {
        newState.flows[flow.id] = {
            id: flow.id,
            name: flow.name,
            controlRefs: [],
            settings: flow.settings || { enforceSequence: true },
            metadata: {
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
        };
        
        // Migrate controls
        (flow.data || []).forEach(control => {
            const controlId = migrateItem(control, 'control', newState);
            newState.flows[flow.id].controlRefs.push(controlId);
        });
    });
    
    // Step 2: Migrate execution data
    console.log('Migrating execution data...');
    Object.keys(oldData.executions.flows).forEach(flowId => {
        const flowExec = oldData.executions.flows[flowId];
        Object.keys(flowExec.completed).forEach(evidenceId => {
            if (newState.executions[evidenceId]) {
                newState.executions[evidenceId].completed = flowExec.completed[evidenceId];
                if (flowExec.completed[evidenceId]) {
                    newState.executions[evidenceId].completedAt = Date.now();
                }
            }
        });
    });
    
    // Step 3: Update flow references for shared items
    console.log('Updating flow references for shared items...');
    Object.values(newState.items).forEach(item => {
        if (item.isShared) {
            // Find all flows that contain this item
            Object.values(newState.flows).forEach(flow => {
                if (flow.controlRefs.includes(item.id)) {
                    addFlowReference(item.id, flow.id, newState);
                } else {
                    // Check if item is in hierarchy of any control in this flow
                    const isInFlow = flow.controlRefs.some(controlId => {
                        return isItemInHierarchy(item.id, controlId, newState);
                    });
                    if (isInFlow) {
                        addFlowReference(item.id, flow.id, newState);
                    }
                }
            });
        }
    });
    
    console.log('Migration completed successfully!');
    console.log(`Migrated ${Object.keys(newState.items).length} items across ${Object.keys(newState.flows).length} flows`);
    
    return newState;
}

// Helper function to migrate individual items
function migrateItem(item, type, newState) {
    const itemId = item.id;
    
    // Create item in registry
    newState.items[itemId] = {
        id: itemId,
        type,
        name: item.name,
        text: item.text || '',
        tags: item.tags || [],
        grade: item.grade,
        footer: item.footer || { links: [], images: [], notes: [], comments: [] },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isShared: !!item.shareKey,
        shareGroup: item.shareKey
    };
    
    // Create hierarchy entry
    newState.itemHierarchy[itemId] = {
        parentId: null,
        childRefs: [],
        flowRefs: []
    };
    
    // Initialize execution data
    newState.executions[itemId] = {
        completed: false,
        grade: item.grade,
        completedAt: null,
        completedBy: null
    };
    
    // Migrate children
    (item.subcategories || []).forEach(child => {
        const childType = type === 'control' ? 'action' : 'evidence';
        const childId = migrateItem(child, childType, newState);
        
        // Set parent-child relationship
        newState.itemHierarchy[itemId].childRefs.push(childId);
        newState.itemHierarchy[childId].parentId = itemId;
    });
    
    return itemId;
}

// Helper function to add flow reference
function addFlowReference(itemId, flowId, newState) {
    if (newState.itemHierarchy[itemId]) {
        if (!newState.itemHierarchy[itemId].flowRefs.includes(flowId)) {
            newState.itemHierarchy[itemId].flowRefs.push(flowId);
        }
    }
}

// Helper function to check if item is in hierarchy
function isItemInHierarchy(itemId, parentId, newState) {
    const hierarchy = newState.itemHierarchy[parentId];
    if (!hierarchy) return false;
    
    if (hierarchy.childRefs.includes(itemId)) return true;
    
    return hierarchy.childRefs.some(childId => 
        isItemInHierarchy(itemId, childId, newState)
    );
}

// Convert new architecture back to old format for saving
function convertToOldFormat(newState) {
    console.log('Converting new architecture to old format for saving...');
    
    const flows = Object.values(newState.flows).map(flow => ({
        id: flow.id,
        name: flow.name,
        data: flow.controlRefs.map(controlId => {
            const control = newState.items[controlId];
            return convertItemToOldFormat(control, newState);
        })
    }));
    
    return {
        settings: { enforceSequence: true },
        flows
    };
}

// Convert individual item to old format
function convertItemToOldFormat(item, newState) {
    const hierarchy = newState.itemHierarchy[item.id];
    const oldItem = {
        id: item.id,
        name: item.name,
        text: item.text,
        tags: item.tags,
        shareKey: item.shareGroup,
        subcategories: hierarchy.childRefs.map(childId => {
            const child = newState.items[childId];
            return convertItemToOldFormat(child, newState);
        })
    };
    
    if (item.type === 'evidence') {
        oldItem.grade = item.grade;
        oldItem.completed = newState.executions[item.id]?.completed || false;
        oldItem.footer = item.footer;
        oldItem.isLocked = false;
        oldItem.isActive = false;
    }
    
    return oldItem;
}

// Convert execution data to old format
function convertExecutionToOldFormat(newState) {
    console.log('Converting execution data to old format...');
    
    const flows = {};
    
    Object.values(newState.flows).forEach(flow => {
        const completed = {};
        
        // Collect all evidence IDs in this flow
        const collectEvidenceIds = (controlId) => {
            const control = newState.items[controlId];
            if (!control) return;
            
            const hierarchy = newState.itemHierarchy[controlId];
            hierarchy.childRefs.forEach(actionId => {
                const action = newState.items[actionId];
                if (!action) return;
                
                const actionHierarchy = newState.itemHierarchy[actionId];
                actionHierarchy.childRefs.forEach(evidenceId => {
                    const exec = newState.executions[evidenceId];
                    if (exec) {
                        completed[evidenceId] = exec.completed;
                    }
                });
            });
        };
        
        flow.controlRefs.forEach(collectEvidenceIds);
        flows[flow.id] = { completed };
    });
    
    return { flows };
}

// Validation function to ensure migration integrity
function validateMigration(oldData, newState) {
    console.log('Validating migration integrity...');
    
    const errors = [];
    const warnings = [];
    
    // Check flow count
    const oldFlowCount = oldData.workflow.flows.length;
    const newFlowCount = Object.keys(newState.flows).length;
    if (oldFlowCount !== newFlowCount) {
        errors.push(`Flow count mismatch: old=${oldFlowCount}, new=${newFlowCount}`);
    }
    
    // Check item count
    let oldItemCount = 0;
    oldData.workflow.flows.forEach(flow => {
        (flow.data || []).forEach(control => {
            oldItemCount++;
            (control.subcategories || []).forEach(action => {
                oldItemCount++;
                (action.subcategories || []).forEach(evidence => {
                    oldItemCount++;
                });
            });
        });
    });
    
    const newItemCount = Object.keys(newState.items).length;
    if (oldItemCount !== newItemCount) {
        errors.push(`Item count mismatch: old=${oldItemCount}, new=${newItemCount}`);
    }
    
    // Check execution data
    let oldExecutionCount = 0;
    Object.values(oldData.executions.flows).forEach(flow => {
        oldExecutionCount += Object.keys(flow.completed).length;
    });
    
    let newExecutionCount = 0;
    Object.values(newState.executions).forEach(exec => {
        if (exec.completed !== undefined) newExecutionCount++;
    });
    
    if (oldExecutionCount !== newExecutionCount) {
        warnings.push(`Execution count mismatch: old=${oldExecutionCount}, new=${newExecutionCount}`);
    }
    
    // Check sharing integrity
    Object.values(newState.items).forEach(item => {
        if (item.isShared) {
            const hierarchy = newState.itemHierarchy[item.id];
            if (hierarchy.flowRefs.length < 2) {
                warnings.push(`Shared item ${item.id} is only referenced by ${hierarchy.flowRefs.length} flow(s)`);
            }
        }
    });
    
    if (errors.length > 0) {
        console.error('Migration validation failed:', errors);
        return false;
    }
    
    if (warnings.length > 0) {
        console.warn('Migration validation warnings:', warnings);
    }
    
    console.log('Migration validation passed!');
    return true;
}

// Export functions for use in the main application
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        migrateToNewArchitecture,
        convertToOldFormat,
        convertExecutionToOldFormat,
        validateMigration
    };
}

// Make functions available globally for browser use
if (typeof window !== 'undefined') {
    window.migrateToNewArchitecture = migrateToNewArchitecture;
    window.convertToOldFormat = convertToOldFormat;
    window.convertExecutionToOldFormat = convertExecutionToOldFormat;
    window.validateMigration = validateMigration;
}