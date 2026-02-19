# Codesafe: A Whiteboard for Developers
=====================================

Overview
--------
CodeSafe is a real-time collaborative coding workspace built to eliminate the friction and inefficiencies of traditional collaborative coding methods. It provides a free, minimalist, browser-based environment where multiple users can create, join, and edit shared projects together in real time.

The platform focuses on simplicity, efficiency, and accessibility, making it especially suitable for beginners, students, and small teams working from different devices without complex or expensive setups.


Problem
-------
Traditional coding workflows make real-time collaboration harder than necessary. Users often rely on:

- Passing files back and forth
- Screen-sharing applications such as Discord or Slack
- Multiple disconnected tools

These methods create friction in the workflow. Edits conflict, feedback is delayed, and productivity suffers due to fragmented and disorganized changes. Maintaining a consistent workspace across collaborators becomes difficult.


Solution
--------
CodeSafe addresses this problem by providing a Google Docs–like experience for coding. Instead of working on separate local copies and merging later, users connect to a shared browser-based project room where all collaboration happens in real time.

Each project room contains a shared Yjs document (CRDT-based) that stores:

- File contents
- File explorer tree structure
- Suggestions and suggestion votes
- Chat messages
- Collaboration metrics (characters typed, suggestions made, etc.)

All edits and structural changes are instantly synchronized across connected clients. Yjs manages concurrent edits, allowing multiple users to type at the same time without conflicts.


Features
--------
Real-Time Collaboration
- Shared project rooms accessible directly from the browser
- Instant synchronization of code, file structure, suggestions, chat, and metrics
- Conflict-free concurrent editing powered by Yjs

File Management
- Collaborative creation, renaming, and deletion of files and folders
- Shared file explorer synchronized across users

Suggestions & Voting
- Users can create suggestions
- Suggestions can be voted on
- Enables structured team coordination

Live Chat
- Built-in chat panel for real-time communication

Leaderboard
- Tracks collaboration metrics
- Adds accountability and gamification

Customizable Layout
- Panels are draggable, resizable, and closable
- Modular and efficient UI
- Panels reset to a default state when the page is re-entered to reduce clutter

Role-Based Permissions
- Viewer
- Editor
- Admin
- Prevents unauthorized edits, renames, or deletions

Persistence
- Project state is restored across sessions
- Data stored using MongoDB


Technical Stack
---------------
Frontend
- React
- TypeScript
- Monaco Editor (integrated with Yjs via y-monaco)
- React-Grid-Layout (for draggable and resizable panels)
- Deployed on Vercel

Backend
- Node.js
- Express
- TypeScript
- Custom WebSocket layer for real-time synchronization
- REST APIs for project management
- Deployed on Railway

Collaboration Engine
- Yjs (CRDT framework with shared types)
- Each project maps to a WebSocket room
- Room state loaded from MongoDB Atlas (cloud-native database service connected to Microsoft Azure cloud)

Database
- MongoDB Atlas
- Stores users, projects, files, suggestions, and other persistent data

Authentication
- Users receive tokens based on their usernames
- Tokens required for API calls and WebSocket room access

Console
- Backend endpoint for running JavaScript and Python
- Includes timeout and output capture

Exporting
- Projects can be exported as .zip files generated from the existing Yjs file state


Summary
-------
CodeSafe provides a clean, minimalist, and highly functional real-time collaborative coding experience. By combining CRDT-based synchronization, shared project rooms, structured collaboration tools, and a modular UI, it eliminates the friction of traditional collaborative coding workflows and creates an efficient, browser-based environment focused on usability and coordination.
