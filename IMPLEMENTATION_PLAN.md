# Implementation Plan: Reference-Based Architecture

## Phase 1: Data Structure Redesign

### 1.1 New Data Structure
```javascript
const appState = {
  // Global item registry - single source of truth
  items: {
    [itemId]: {
      id: string,
      type: 'control'|'action'|'evidence',
      name: string,
      text: string,
      tags: string[],
      grade?: number, // Only for evidence
      footer?: {
        links: [{ url: string, text: string }],
        images: [string],
        notes: [{ title: string, content: string }],
        comments: [string]
      },
      subcategories?: [], // For backward compatibility during migration
      // Metadata
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy?: string,
      // Sharing metadata
      isShared: boolean,
      originalId?: string, // For cloned items
      shareGroup?: string // Groups shared items
    }
  },
  
  // Flow structure with references
  flows: {
    [flowId]: {
      id: string,
      name: string,
      controlRefs: [itemId], // References to control items
      settings: {
        enforceSequence: boolean
      },
      metadata: {
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  },
  
  // Hierarchical relationships
  itemHierarchy: {
    [itemId]: {
      parentId?: string, // Parent item ID
      childRefs: [itemId], // Child item IDs
      flowRefs: [flowId] // Flows that reference this item
    }
  },
  
  // Unified execution data by item ID
  executions: {
    [itemId]: {
      completed: boolean,
      grade?: number, // Current grade (can differ from item.grade)
      completedAt?: timestamp,
      completedBy?: string
    }
  },
  
  // UI state (unchanged)
  currentFlowId: string,
  currentMode: 'creation'|'execution',
  selectedActionPaths: {},
  expandedTextAreas: Set,
  activeTag: string,
  theme: 'light'|'dark'
};
```

### 1.2 Core Functions Redesign

#### Item Management
```javascript
// Create new item
const createItem = (type, data, parentId = null) => {
  const id = generateId(type === 'control' ? 'ctl' : type === 'action' ? 'act' : 'evi');
  const item = {
    id,
    type,
    ...data,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isShared: false
  };
  
  appState.items[id] = item;
  
  if (parentId) {
    addChildToParent(parentId, id);
  }
  
  return item;
};

// Get item by ID
const getItem = (id) => appState.items[id];

// Update item
const updateItem = (id, updates) => {
  if (appState.items[id]) {
    appState.items[id] = {
      ...appState.items[id],
      ...updates,
      updatedAt: Date.now()
    };
    
    // Notify all flows that reference this item
    notifyItemUpdate(id);
  }
};

// Delete item
const deleteItem = (id) => {
  const item = appState.items[id];
  if (!item) return;
  
  // Remove from all flows
  removeItemFromAllFlows(id);
  
  // Remove children
  const hierarchy = appState.itemHierarchy[id];
  if (hierarchy) {
    hierarchy.childRefs.forEach(childId => deleteItem(childId));
  }
  
  // Remove from registry
  delete appState.items[id];
  delete appState.itemHierarchy[id];
  delete appState.executions[id];
};
```

#### Sharing System
```javascript
// Share item to flow (add reference)
const shareItem = (itemId, targetFlowId, targetParentId = null) => {
  const item = getItem(itemId);
  const targetFlow = appState.flows[targetFlowId];
  
  if (!item || !targetFlow) {
    throw new Error('Item or flow not found');
  }
  
  // Validate parent exists in target flow
  if (targetParentId && !validateParentInFlow(targetParentId, targetFlowId)) {
    throw new Error('Parent not found in target flow');
  }
  
  // Add reference to flow
  if (item.type === 'control') {
    targetFlow.controlRefs.push(itemId);
  } else {
    // Add to parent's children
    addChildToParent(targetParentId, itemId);
  }
  
  // Update item metadata
  updateItem(itemId, { isShared: true });
  
  // Add flow reference
  addFlowReference(itemId, targetFlowId);
};

// Clone item (create new item with same data)
const cloneItem = (itemId, targetFlowId, targetParentId = null) => {
  const originalItem = getItem(itemId);
  if (!originalItem) {
    throw new Error('Item not found');
  }
  
  // Create new item with same data
  const clonedData = {
    ...originalItem,
    id: generateId(originalItem.type === 'control' ? 'ctl' : originalItem.type === 'action' ? 'act' : 'evi'),
    originalId: itemId,
    isShared: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  
  // Remove original-specific properties
  delete clonedData.subcategories;
  
  const newItem = createItem(originalItem.type, clonedData, targetParentId);
  
  // Clone children recursively
  const hierarchy = appState.itemHierarchy[itemId];
  if (hierarchy) {
    hierarchy.childRefs.forEach(childId => {
      cloneItem(childId, targetFlowId, newItem.id);
    });
  }
  
  return newItem;
};
```

#### Flow Management
```javascript
// Create new flow
const createFlow = (name, sourceFlowId = null, mode = 'empty') => {
  const flowId = generateId('flow');
  const flow = {
    id: flowId,
    name,
    controlRefs: [],
    settings: { enforceSequence: true },
    metadata: {
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  };
  
  if (mode === 'clone' && sourceFlowId) {
    // Clone all controls from source flow
    const sourceFlow = appState.flows[sourceFlowId];
    sourceFlow.controlRefs.forEach(controlId => {
      const clonedControl = cloneItem(controlId, flowId);
      flow.controlRefs.push(clonedControl.id);
    });
  } else if (mode === 'share' && sourceFlowId) {
    // Share all controls from source flow
    const sourceFlow = appState.flows[sourceFlowId];
    sourceFlow.controlRefs.forEach(controlId => {
      shareItem(controlId, flowId);
    });
  }
  
  appState.flows[flowId] = flow;
  return flow;
};

// Get flow data for rendering
const getFlowData = (flowId) => {
  const flow = appState.flows[flowId];
  if (!flow) return [];
  
  return flow.controlRefs.map(controlId => {
    const control = getItem(controlId);
    return buildItemHierarchy(control);
  });
};

// Build complete hierarchy for rendering
const buildItemHierarchy = (item) => {
  const hierarchy = appState.itemHierarchy[item.id];
  if (!hierarchy) return item;
  
  return {
    ...item,
    subcategories: hierarchy.childRefs.map(childId => {
      const child = getItem(childId);
      return buildItemHierarchy(child);
    })
  };
};
```

## Phase 2: Rendering System Update

### 2.1 Render Function Redesign
```javascript
const render = () => {
  // ... existing UI setup code ...
  
  const currentFlow = getCurrentFlow();
  if (!currentFlow) {
    workflowRoot.innerHTML = '<div class="empty-state">No flows. Create one to get started.</div>';
    return;
  }
  
  // Get flow data using new system
  const flowData = getFlowData(currentFlow.id);
  
  // Render using existing logic but with new data structure
  workflowRoot.innerHTML = '';
  if (flowData.length === 0) {
    workflowRoot.innerHTML = '<div class="empty-state">This flow is empty. Add a rule.</div>';
    return;
  }
  
  const frag = document.createDocumentFragment();
  flowData.forEach((control, index) => {
    const pathForControl = `data.${index}`;
    frag.appendChild(renderControlNode(control, pathForControl, false, currentFlow));
  });
  workflowRoot.appendChild(frag);
};
```

### 2.2 Event Handler Updates
```javascript
// Update event handlers to work with new system
const handleAppClick = (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  
  const action = btn.dataset.action;
  const itemId = btn.dataset.itemId; // New: direct item ID
  const path = btn.dataset.path; // Keep for backward compatibility
  
  // ... existing action handling logic ...
  
  const actions = {
    'add-action': () => {
      const n = prompt("Enter new Action name:");
      if (!n) return;
      
      const newAction = createItem('action', {
        name: n,
        text: '',
        tags: []
      }, itemId);
      
      // If parent is shared, share the new action
      const parent = getItem(itemId);
      if (parent.isShared) {
        shareNewItemToAllFlows(newAction.id, parent.id);
      }
    },
    
    'edit-name': () => {
      const n = prompt("Enter new name:", getItem(itemId).name);
      if (n === null) return;
      
      updateItem(itemId, { name: n });
      render();
    },
    
    'delete-node': () => {
      const item = getItem(itemId);
      if (!confirm(`Delete "${item.name}"?`)) return;
      
      deleteItem(itemId);
      render();
    },
    
    // ... other actions ...
  };
  
  if (actions[action]) {
    actions[action]();
  }
};
```

## Phase 3: Migration System

### 3.1 Migration Script
```javascript
const migrateToNewArchitecture = (oldData) => {
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
  
  // Migrate flows
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
  
  // Migrate execution data
  Object.keys(oldData.executions.flows).forEach(flowId => {
    const flowExec = oldData.executions.flows[flowId];
    Object.keys(flowExec.completed).forEach(evidenceId => {
      newState.executions[evidenceId] = {
        completed: flowExec.completed[evidenceId]
      };
    });
  });
  
  return newState;
};

const migrateItem = (item, type, newState) => {
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
  
  // Migrate children
  (item.subcategories || []).forEach(child => {
    const childType = type === 'control' ? 'action' : 'evidence';
    const childId = migrateItem(child, childType, newState);
    
    // Set parent-child relationship
    newState.itemHierarchy[itemId].childRefs.push(childId);
    newState.itemHierarchy[childId].parentId = itemId;
  });
  
  return itemId;
};
```

## Phase 4: Backward Compatibility

### 4.1 Wrapper Functions
```javascript
// Wrapper functions to maintain existing API
const getObjectByPath = (path, flow) => {
  // Convert path to item ID and return item
  const parts = path.split('.');
  // ... path resolution logic ...
  return getItem(itemId);
};

const getCurrentFlow = () => {
  return appState.flows[appState.currentFlowId] || null;
};

// ... other wrapper functions ...
```

### 4.2 Gradual Migration
```javascript
// Feature flag for new architecture
const USE_NEW_ARCHITECTURE = true;

const loadAll = async () => {
  try {
    const [wfRes, exRes] = await Promise.all([
      fetch(`workflow.json?t=${Date.now()}`),
      fetch(`executions.json?t=${Date.now()}`)
    ]);
    
    if (!wfRes.ok) throw new Error('Failed to load workflow.json');
    const workflowData = await wfRes.json();
    
    if (exRes.ok) {
      const executionData = await exRes.json();
      
      if (USE_NEW_ARCHITECTURE) {
        // Migrate to new architecture
        appState = migrateToNewArchitecture({ workflow: workflowData, executions: executionData });
      } else {
        // Use old architecture
        appState.workflow = workflowData;
        appState.executions = executionData;
      }
    }
    
    // ... rest of initialization ...
  } catch (e) {
    console.error(e);
    // ... error handling ...
  }
};
```

## Phase 5: Testing Strategy

### 5.1 Unit Tests
- Test item creation, updating, deletion
- Test sharing and cloning
- Test flow management
- Test execution data handling

### 5.2 Integration Tests
- Test complete workflows
- Test data migration
- Test backward compatibility
- Test performance with large datasets

### 5.3 User Acceptance Tests
- Test all existing functionality
- Test new sharing behavior
- Test UI/UX consistency
- Test data integrity

## Phase 6: Implementation Timeline

### Week 1: Data Structure
- Implement new data structure
- Create core item management functions
- Implement sharing and cloning logic

### Week 2: Rendering System
- Update rendering functions
- Update event handlers
- Implement flow management

### Week 3: Migration System
- Create migration scripts
- Implement backward compatibility
- Test data migration

### Week 4: Testing & Refinement
- Comprehensive testing
- Performance optimization
- Bug fixes and refinements

## Phase 7: Rollout Strategy

### 7.1 Feature Flag
- Use feature flag to switch between old and new architecture
- Allow gradual rollout
- Easy rollback if issues arise

### 7.2 Data Backup
- Backup existing data before migration
- Implement data validation
- Provide migration rollback

### 7.3 User Communication
- Document changes
- Provide migration guide
- Maintain support for both systems during transition

This plan ensures a smooth transition to the new reference-based architecture while preserving all existing functionality and providing a better foundation for future development.