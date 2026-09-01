import base64
import io
import os
import tempfile
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = tempfile.TemporaryDirectory()
os.environ["DATA_DIR"] = _tmp.name
os.environ["AUTH_ENABLED"] = "false"

from app.app import app  # noqa: E402


class SmokeTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "ok")

    def test_crud_and_backup(self):
        created = self.client.post("/api/items", json={"name": "ESP32", "quantity": 3}).get_json()
        self.assertEqual(created["name"], "ESP32")
        listing = self.client.get("/api/items").get_json()
        self.assertTrue(any(row["id"] == created["id"] for row in listing))
        backup = self.client.get("/api/export/backup").get_json()
        self.assertEqual(backup["format"], "maker-inventar-backup")
        self.assertEqual(backup["version"], 2)
        preview = self.client.post("/api/import/preview", json=backup)
        self.assertEqual(preview.status_code, 200)

    def test_item_image_lifecycle(self):
        created = self.client.post("/api/items", json={"name": "BME280", "quantity": 1}).get_json()
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        uploaded = self.client.post(
            f"/api/items/{created['id']}/image",
            data={"image": (io.BytesIO(png), "sensor.png")},
            content_type="multipart/form-data",
        )
        self.assertEqual(uploaded.status_code, 200)
        item = self.client.get(f"/api/items/{created['id']}").get_json()
        self.assertEqual(item["image_mime_type"], "image/png")
        image = self.client.get(f"/api/items/{created['id']}/image")
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.mimetype, "image/png")
        deleted = self.client.delete(f"/api/items/{created['id']}/image")
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.client.get(f"/api/items/{created['id']}/image").status_code, 404)

    def test_cors_is_exact(self):
        os.environ["PWA_ALLOWED_ORIGIN"] = "https://app.example.com"
        ok = self.client.options("/api/items", headers={"Origin": "https://app.example.com"})
        self.assertEqual(ok.headers.get("Access-Control-Allow-Origin"), "https://app.example.com")
        bad = self.client.options("/api/items", headers={"Origin": "https://evil.example"})
        self.assertIsNone(bad.headers.get("Access-Control-Allow-Origin"))


if __name__ == "__main__":
    unittest.main()
