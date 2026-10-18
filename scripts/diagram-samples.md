# Diagram renderer comparison

The same Mermaid source renders in both readers. The only difference between the two files is the `diagrams: mermaid` frontmatter in the Mermaid file.

## Review loop

A flowchart with subgraphs, labeled edges and a feedback cycle.

```mermaid
flowchart LR
  subgraph Human
    W[Write draft] --> C{Comment?}
  end
  subgraph Agent
    P[Read pending] --> R[Reply in thread]
  end
  C -- yes --> P
  C -- no --> S[(Saved file)]
  R --> D{Resolved?}
  D -- no --> W
  D -- yes --> S
```

## Comment round trip

A sequence diagram with activations, a note and an alternative.

```mermaid
sequenceDiagram
  autonumber
  participant H as Human
  participant T as Tether daemon
  participant A as Agent
  H->>T: Comment on a passage
  activate T
  T-->>A: pending event
  deactivate T
  A->>T: thread <id>
  T-->>A: bounded context
  Note over A,T: Agent reads only what it needs
  alt Needs a decision
    A->>T: reply, leave open
  else Done
    A->>T: reply and resolve
  end
  T-->>H: Thread updated
```

## Thread lifecycle

A state diagram with a composite state.

```mermaid
stateDiagram-v2
  [*] --> Open
  Open --> Acknowledged: agent reviews
  Acknowledged --> Answered: agent replies
  Answered --> Resolved: human closes
  Resolved --> Open: reopen
  state Answered {
    [*] --> AwaitingHuman
    AwaitingHuman --> FollowUp: human replies
    FollowUp --> AwaitingHuman: agent replies
  }
  Resolved --> [*]
```

## Visual anchor model

A class diagram.

```mermaid
classDiagram
  class AnnotationAnchor {
    +string exact
    +string prefix
    +string suffix
    +number projectionStart
    +VisualAnchor visual
  }
  class VisualAnchor {
    +string kind
    +string source
    +string layoutRevision
    +Region region
    +validate()
  }
  class Region {
    +number x
    +number y
    +number width
    +number height
  }
  AnnotationAnchor --> "0..1" VisualAnchor
  VisualAnchor *-- Region
```

## Private review storage

An entity-relationship diagram.

```mermaid
erDiagram
  DOCUMENT ||--o{ THREAD : has
  THREAD ||--|{ COMMENT : contains
  COMMENT ||--o| EVIDENCE : cites
  DOCUMENT {
    string path PK
    string bodyRevision
  }
  THREAD {
    string id PK
    string state
  }
  EVIDENCE {
    string sha256 PK
    int bytes
  }
```

## Release plan

A Gantt chart.

```mermaid
gantt
  title Renderer evaluation
  dateFormat YYYY-MM-DD
  section Build
    Pele preview       :done, b1, 2026-10-18, 1d
    Theme mapping      :active, b2, after b1, 2d
  section Measure
    Metrics harness    :m1, after b1, 2d
    Mobile review      :crit, m2, after m1, 2d
  section Decide
    Default renderer   :milestone, d1, after m2, 0d
```

## Feature map

A mindmap.

```mermaid
mindmap
  root((Tether))
    Reading
      Themes
      Folio
      Find
    Review
      Threads
      Visual regions
      Agent replies
    Hosts
      Paseo
      cmux
      Wave
```

## Where review time goes

A pie chart.

```mermaid
pie showData
  title Review time
  "Reading" : 42
  "Commenting" : 23
  "Agent replies" : 18
  "Resolving" : 9
  "Searching" : 8
```

## Branch flow

A git graph.

```mermaid
gitGraph
  commit id: "base"
  branch pele-demo
  checkout pele-demo
  commit id: "renderer"
  commit id: "themes"
  checkout main
  commit id: "fix"
  checkout pele-demo
  merge main
  commit id: "metrics"
  checkout main
  merge pele-demo
```

## Release history

A timeline.

```mermaid
timeline
  title Tether releases
  0.1.3 : Duplicate passage anchors
  0.1.4 : Visual region annotations : Scoped thread drawers
  0.1.5 : Code block annotations : Folio batch tools
  Next : Lighter diagrams
```

## Reviewer journey

A user journey.

```mermaid
journey
  title Reviewing a diagram on a phone
  section Open
    Find the document: 4: Human
    Load the diagram: 2: Human
  section Read
    Zoom and pan: 2: Human
    Follow an edge: 3: Human
  section Comment
    Select a region: 3: Human, Agent
    Read the reply: 5: Human
```

## Effort against value

A quadrant chart.

```mermaid
quadrantChart
  title Diagram features
  x-axis Low effort --> High effort
  y-axis Low value --> High value
  quadrant-1 Plan
  quadrant-2 Do now
  quadrant-3 Skip
  quadrant-4 Reconsider
  Theme tokens: [0.2, 0.85]
  Node comments: [0.55, 0.8]
  Mobile layout: [0.3, 0.7]
  Hover tracing: [0.35, 0.55]
  Custom shapes: [0.8, 0.3]
```

## Render time

An XY chart.

```mermaid
xychart-beta
  title "Median render time (ms)"
  x-axis [Flow, Sequence, State, Class, ER, Gantt]
  y-axis "Milliseconds" 0 --> 60
  bar [22, 14, 18, 25, 20, 30]
  line [0.4, 0.3, 0.3, 0.5, 0.4, 0.6]
```

## Attention budget

A Sankey diagram.

```mermaid
sankey-beta
Reading,Understanding,40
Reading,Skimming,20
Diagrams,Understanding,25
Diagrams,Confusion,10
Understanding,Comments,30
Confusion,Comments,10
Skimming,Nothing,20
```

## Service layout

An architecture diagram.

```mermaid
architecture-beta
  group host(cloud)[Host]
  service reader(internet)[Reader] in host
  service daemon(server)[Daemon] in host
  service store(database)[SQLite] in host
  service agent(disk)[Agent]
  reader:R --> L:daemon
  daemon:R --> L:store
  agent:T --> B:daemon
```
