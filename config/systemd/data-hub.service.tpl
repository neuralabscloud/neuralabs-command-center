[Unit]
Description=Data Hub — Central Market Data Service
After=network.target redis-server.service
Requires=redis-server.service

[Service]
Type=simple
WorkingDirectory={{INSTALL_DIR}}/data-hub
ExecStart={{INSTALL_DIR}}/data-hub/venv/bin/python run.py
EnvironmentFile={{INSTALL_DIR}}/.env
Environment=PYTHONUNBUFFERED=1
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
