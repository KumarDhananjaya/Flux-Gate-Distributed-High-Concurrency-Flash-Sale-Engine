Workflows & User Experience Diagrams
This document visually details the operational flows for Customers and Distributors within the IRIS platform.

1. High-Level Interaction Flow
This diagram illustrates how Customers and Distributors interact with the ecosystem.

graph TD
    subgraph "Customer Ecosystem"
        C[Customer] -->|Controls via BLE| D[IRIS Device]
        C -->|Request Service| API[Backend API]
        D -->|BLE Telemetry| C
    end

    subgraph "Distributor Ecosystem"
        DIST[Distributor] -->|Monitors Fleet| API
        DIST -->|Manages Tickets| API
        DIST -->|Onboards Clients| API
    end

    subgraph "Cloud Infrastructure"
        API -->|Persist Data| DB[(Database)]
        API -->|Push Notify| C
        API -->|Push Notify| DIST
    end

    %% Key Interactions
    C -.->|1. Raise Refill Ticket| DIST
    DIST -.->|2. Fulfill Service| C
2. User Experience (UX) Journey Maps
A. Customer Journey
The end-to-end experience for a home or business user managing their own devices.

journey
    title Customer App Usage Flow
    section Onboarding
      Sign Up/Login: 5: Customer
      Grant Permissions (BLE/Loc): 4: Customer, App
    section Setup
      Scan for Devices: 5: Customer, App
      Pair Device (PIN): 3: Customer, App, Device
      Assign to Room: 5: Customer
    section Daily Use
      View Dashboard: 5: Customer
      Adjust Intensity: 5: Customer, Device
      Set Schedules: 4: Customer, Device
    section Support
      Receive Low Oil Alert: 3: Device, App
      Request Refill: 5: Customer
      Track Ticket Status: 4: Customer
B. Distributor Journey
The workflow for a distributor managing multiple clients and devices.

journey
    title Distributor Portal Flow
    section Start
      Login: 5: Distributor
      View Business Dashboard: 5: Distributor
    section Client Mgmt
      View Client List: 5: Distributor
      Drill-down to Client Devices: 4: Distributor
      Check Oil Levels Remote: 3: Distributor
    section Service
      Receive Refill Ticket: 2: Distributor
      Assign Technician: 4: Distributor
      Mark Resolved: 5: Distributor
3. Detailed Sequence Diagrams
A. Refill Service Loop (Customer <-> Distributor)
This sequence shows the lifecycle of a service request.

sequenceDiagram
    autonumber
    actor C as Customer
    participant CA as Customer App
    participant API as Backend API
    participant DB as MongoDB
    participant DA as Distributor App
    actor D as Distributor

    box "Initiation"
    C->>CA: Taps "Order Refill"
    CA->>CA: Checks Current Oil Level
    CA->>API: POST /tickets (deviceId, issue="Low Oil")
    API->>DB: Create Ticket (Status: OPEN)
    API-->>CA: Return Ticket ID
    end

    box "Notification"
    DB->>API: Ticket Created Event
    API->>DA: Send Push Notification ("New Refill Request")
    end

    box "Resolution"
    D->>DA: Open Ticket Details
    D->>DA: Approve/Assign Service
    D->>DA: Mark as RESOLVED
    DA->>API: PUT /tickets/:id (status="RESOLVED")
    API->>DB: Update Status & LastRefillDate
    end

    box "Completion"
    API->>CA: Send Push Notification ("Service Completed")
    CA->>C: Update UI (Ticket Closed)
    end
B. Device Pairing & Control (BLE Flow)
How a customer claims and controls a hardware device.

sequenceDiagram
    actor C as Customer
    participant App
    participant BLE as BLE Manager
    participant Dev as IRIS Device
    participant API as Cloud

    Note over C, Dev: Phase 1: Discovery & Pairing
    C->>App: Start Scan
    App->>BLE: scan()
    BLE-->>App: Device Found (Name: IRIS_A1)
    C->>App: Select Device & Enter PIN
    App->>BLE: connect(IRIS_A1)
    BLE->>Dev: Auth Handshake (PIN)
    Dev-->>BLE: Auth Success
    BLE-->>App: Connected

    Note over C, API: Phase 2: Registration
    App->>API: Register Device (MAC, OwnerID)
    API-->>App: Success + DeviceID

    Note over C, Dev: Phase 3: Control
    C->>App: Change Fan Speed -> HIGH
    App->>BLE: writeCharacteristic(Fan=High)
    BLE->>Dev: Send Bytes [0xAB, ...]
    Dev-->>BLE: ACK
    App->>C: Show Success Toast
C. Data Sync Optimization
How the app ensures the dashboard is up-to-date without draining battery.

sequenceDiagram
    participant UI as Dashboard UI
    participant Store as Redux Store
    participant API as Cloud/API

    UI->>Store: Subscribe to Device List
    
    par Periodic Poll
        loop Every 30s
            Store->>API: Fetch Devices (Snapshot)
            API-->>Store: JSON Data
            Store->>UI: Update Oil/Battery/Online Status
        end
    and Real-time Override
        Note right of UI: When user opens specific control screen
        UI->>Store: Connect BLE (High Frequency Updates)
        Store->>UI: Live Telemetry (ms latency)
    end
