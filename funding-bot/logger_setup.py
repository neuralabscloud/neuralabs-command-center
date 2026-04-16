import logging
import os
from logging.handlers import RotatingFileHandler
from config import LOG_LEVEL, LOG_FILE

def setup_logger(name: str = "NeuraLabsBot", log_file: str = None) -> logging.Logger:
    target_file = log_file or LOG_FILE
    os.makedirs(os.path.dirname(target_file), exist_ok=True)
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, LOG_LEVEL.upper(), logging.INFO))
    logger.propagate = False  # Voorkom dubbele regels via root logger
    if logger.handlers:
        return logger
    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)
    file_handler = RotatingFileHandler(target_file, maxBytes=5*1024*1024, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    return logger
