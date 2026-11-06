"""Saved analyser set-ups: list, read, create, update, delete."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from .. import analyses
from ..analyses import AnalysisCreate, AnalysisUpdate
from ..deps import get_conn, ok

router = APIRouter()

Conn = Depends(get_conn)


@router.get("/analyses")
def list_analyses(conn: sqlite3.Connection = Conn) -> dict:
    return ok(analyses.list_analyses(conn))


@router.post("/analyses", status_code=201)
def create_analysis(body: AnalysisCreate, conn: sqlite3.Connection = Conn) -> dict:
    return ok(analyses.get_analysis(conn, analyses.create_analysis(conn, body)))


@router.get("/analyses/{analysis_id}")
def get_analysis(analysis_id: int, conn: sqlite3.Connection = Conn) -> dict:
    return ok(analyses.get_analysis(conn, analysis_id))


@router.put("/analyses/{analysis_id}")
def update_analysis(analysis_id: int, body: AnalysisUpdate, conn: sqlite3.Connection = Conn) -> dict:
    analyses.update_analysis(conn, analysis_id, body)
    return ok(analyses.get_analysis(conn, analysis_id))


@router.delete("/analyses/{analysis_id}")
def delete_analysis(analysis_id: int, conn: sqlite3.Connection = Conn) -> dict:
    analyses.delete_analysis(conn, analysis_id)
    return ok({"deleted": analysis_id})
